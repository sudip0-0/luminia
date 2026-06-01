// Authenticated service routes (task 28.1).
//
// Mounts the authenticated REST surface behind the access-token guard (installed
// by app.ts, which attaches the verified user to `request.auth`). Each handler
// is a thin adapter over a pure service, mapping the service's discriminated
// result onto the uniform HTTP envelope and status.
//
// Routes whose services need external clients are mounted only when those
// clients are injected: Feed needs a Redis returned-set ({@link FeedReturnedSet});
// Search needs a Typesense-backed {@link ArticleSearchClient}. Notification
// preferences and every db-only route are always mounted.

import {
  ERROR_CODES,
  makeError,
  type ApiErrorEnvelope,
  type UserRankingContext,
} from '@lumina/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  getUserEmbedding,
  listCollections,
  listUserTopics,
  updateUserProfile,
  type Queryable,
} from './repositories/index.js';
import { getProfile, updateProfile, type ProfilePatch } from './auth/profile.js';
import { createArticleDataAccess, getArticleDetail } from './articles/detail.js';
import { createTopicMuteDataAccess, muteTopic, unmuteTopic } from './topics/mute.js';
import { ingestBatch } from './events/ingest.js';
import {
  listSaved,
  saveArticle,
  setReadState,
  unsaveArticle,
} from './library/saves.js';
import {
  addArticleToCollection,
  createCollection,
  deleteCollection,
  updateCollection,
  type CreateCollectionInput,
  type UpdateCollectionPatch,
} from './library/collections.js';
import { getMonthlyInsights } from './insights/monthly.js';
import { getTopicBreakdown } from './insights/topics.js';
import {
  acceptEmergingInterest,
  getEmergingInterests,
  getFeedEvolutionNarrative,
} from './insights/emerging.js';
import { assembleFeed, type FeedReturnedSet } from './feed/assembly.js';
import { getTabs } from './feed/tabs.js';
import { search, type ArticleSearchClient } from './search/service.js';
import { setPreferences } from './notifications/service.js';
import type { SearchFilters } from './search/filters.js';

/** Dependencies for the authenticated routes. */
export interface AuthedRoutesDeps {
  db: Queryable;
  /** Redis returned-set; when present, the Feed routes are mounted. */
  redis?: FeedReturnedSet;
  /** Typesense-backed search client; when present, the Search route is mounted. */
  search?: ArticleSearchClient;
}

/** Map a uniform error envelope's stable code onto its HTTP status. */
function statusForError(envelope: ApiErrorEnvelope): number {
  switch (envelope.error.code) {
    case 'NOT_FOUND':
      return 404;
    case 'AUTH_FAILED':
      return 401;
    case 'CONFLICT':
      return 409;
    case 'FORBIDDEN':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 400;
  }
}

/** Send a uniform error envelope at the status implied by its code. */
function sendError(reply: FastifyReply, envelope: ApiErrorEnvelope): FastifyReply {
  return reply.code(statusForError(envelope)).send(envelope);
}

/** Build the optional, conjunctive search filters from query params. */
function parseSearchFilters(q: Record<string, string | undefined>): SearchFilters {
  const filters: SearchFilters = {};
  if (q.source) filters.source = q.source as SearchFilters['source'];
  if (q.topic) filters.topic = q.topic;
  if (q.readTimeMin !== undefined || q.readTimeMax !== undefined) {
    filters.readTime = {
      ...(q.readTimeMin !== undefined ? { min: Number(q.readTimeMin) } : {}),
      ...(q.readTimeMax !== undefined ? { max: Number(q.readTimeMax) } : {}),
    };
  }
  if (q.from !== undefined || q.to !== undefined) {
    filters.dateRange = {
      ...(q.from !== undefined ? { from: Number(q.from) } : {}),
      ...(q.to !== undefined ? { to: Number(q.to) } : {}),
    };
  }
  return filters;
}

/**
 * Build the authenticated routes plugin. Every route runs after the guard, so
 * `request.auth.userId` is always present.
 */
export function authenticatedRoutes(deps: AuthedRoutesDeps) {
  const { db } = deps;
  return async (app: FastifyInstance): Promise<void> => {
    const articleData = createArticleDataAccess(db);
    const muteData = createTopicMuteDataAccess(db);

    // Profile (Requirements 26.1-26.4).
    app.get('/me', async (request, reply) => {
      const result = await getProfile({ db }, request.auth!.userId);
      return result.ok ? result.profile : sendError(reply, result.error);
    });

    app.patch('/me', async (request, reply) => {
      const result = await updateProfile(
        { db },
        request.auth!.userId,
        (request.body ?? {}) as ProfilePatch,
      );
      return result.ok ? result.profile : sendError(reply, result.error);
    });

    // Article detail + related articles (Requirements 11, 20.1-20.3).
    app.get('/articles/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await getArticleDetail(articleData, id);
      return result.status === 'ok' ? result.detail : sendError(reply, result.error);
    });

    // Topic mute / unmute (Requirements 25.2-25.6).
    app.post('/topics/:id/mute', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await muteTopic(muteData, request.auth!.userId, id);
      return result.status === 'ok' ? result.topic : sendError(reply, result.error);
    });

    app.post('/topics/:id/unmute', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await unmuteTopic(muteData, request.auth!.userId, id);
      return result.status === 'ok' ? result.topic : sendError(reply, result.error);
    });

    // Behaviour-event ingestion (Requirement 13).
    app.post('/events', async (request, reply) => {
      const result = await ingestBatch(
        { db },
        request.auth!.userId,
        (request.body ?? { events: [] }) as Parameters<typeof ingestBatch>[2],
      );
      return result.status === 'ok' ? result.ack : sendError(reply, result.error);
    });

    // Library saves (Requirements 21.1, 21.2, 21.5, 21.6).
    app.post('/library/saves/:id', async (request) => {
      const { id } = request.params as { id: string };
      return saveArticle({ db }, request.auth!.userId, id);
    });

    app.delete('/library/saves/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await unsaveArticle({ db }, request.auth!.userId, id);
      return result.ok ? result.record : sendError(reply, result.error);
    });

    // Saved-articles listing + read state (Requirements 21.3, 21.4).
    app.get('/library/saves', async (request, reply) => {
      const q = request.query as { state?: 'read' | 'unread'; source?: string; cursor?: string };
      const result = await listSaved(
        { db },
        request.auth!.userId,
        q as Parameters<typeof listSaved>[2],
      );
      return result.ok ? result.results : sendError(reply, result.error);
    });

    app.patch('/library/saves/:id/read-state', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { state?: unknown };
      if (body.state !== 'read' && body.state !== 'unread') {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, '`state` must be "read" or "unread".'),
        );
      }
      const result = await setReadState({ db }, request.auth!.userId, id, body.state);
      return result.ok ? result.record : sendError(reply, result.error);
    });

    // Collections CRUD (Requirements 22.1-22.7).
    app.get('/library/collections', async (request) =>
      listCollections(db, request.auth!.userId),
    );

    app.post('/library/collections', async (request, reply) => {
      const result = await createCollection(
        { db },
        request.auth!.userId,
        (request.body ?? {}) as CreateCollectionInput,
      );
      return result.ok ? result.collection : sendError(reply, result.error);
    });

    app.patch('/library/collections/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await updateCollection(
        { db },
        request.auth!.userId,
        id,
        (request.body ?? {}) as UpdateCollectionPatch,
      );
      return result.ok ? result.collection : sendError(reply, result.error);
    });

    app.delete('/library/collections/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await deleteCollection({ db }, request.auth!.userId, id);
      return result.ok ? result.collection : sendError(reply, result.error);
    });

    app.post('/library/collections/:id/articles', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { articleId?: string };
      const result = await addArticleToCollection(
        { db },
        request.auth!.userId,
        id,
        body.articleId ?? '',
      );
      return result.ok ? result.membership : sendError(reply, result.error);
    });

    // Insights (Requirements 24.1-24.10) — all db-only reads + emerging accept.
    app.get('/insights/monthly', async (request) =>
      getMonthlyInsights({ db }, request.auth!.userId, Date.now()),
    );

    app.get('/insights/topics', async (request) =>
      getTopicBreakdown({ db }, request.auth!.userId, Date.now()),
    );

    app.get('/insights/emerging', async (request) =>
      getEmergingInterests({ db }, request.auth!.userId),
    );

    app.get('/insights/narrative', async (request) =>
      getFeedEvolutionNarrative({ db }, request.auth!.userId, Date.now()),
    );

    app.post('/insights/emerging/:id/accept', async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await acceptEmergingInterest({ db }, request.auth!.userId, id);
      return result.ok ? { topicId: result.topicId } : sendError(reply, result.error);
    });

    // Active feed tabs (Requirement 8.5) — needs only the db.
    app.get('/feed/tabs', async (request) => getTabs({ db }, request.auth!.userId));

    // Notification preferences toggle (Requirement 18, the exposed toggle).
    app.patch('/notifications/preferences', async (request, reply) => {
      const body = (request.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, '`enabled` must be a boolean.'),
        );
      }
      const preferences = {
        async setPushEnabled(userId: string, enabled: boolean): Promise<boolean | null> {
          const rec = await updateUserProfile(db, userId, { pushEnabled: enabled });
          return rec ? rec.pushEnabled : null;
        },
      };
      const result = await setPreferences({ preferences }, request.auth!.userId, body.enabled);
      if (result.status === 'not-found') {
        return sendError(reply, makeError(ERROR_CODES.NOT_FOUND, 'User not found.'));
      }
      return { enabled: result.enabled };
    });

    // Feed assembly (Requirements 8, 9, 10) — mounted when Redis is injected.
    if (deps.redis) {
      const redis = deps.redis;
      app.get('/feed', async (request, reply) => {
        const userId = request.auth!.userId;
        const query = request.query as { tab?: string; cursor?: string };
        const embeddingRec = await getUserEmbedding(db, userId);
        const topics = await listUserTopics(db, userId);
        const userCtx: UserRankingContext = {
          embedding: embeddingRec?.embedding ?? null,
          onboardingTopicIds: topics
            .filter((t) => t.source === 'onboarding')
            .map((t) => t.topicId),
        };
        const result = await assembleFeed(
          { db, redis },
          { userId, tab: query.tab ?? 'foryou', cursor: query.cursor, userCtx },
        );
        return result.ok ? result.response : sendError(reply, result.error);
      });
    }

    // Full-text search (Requirement 20) — mounted when a search client is injected.
    if (deps.search) {
      const client = deps.search;
      app.get('/search', async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const result = await search(
          { client },
          { q: query.q ?? '', filters: parseSearchFilters(query), cursor: query.cursor },
        );
        return result.ok ? result.results : sendError(reply, result.error);
      });
    }
  };
}

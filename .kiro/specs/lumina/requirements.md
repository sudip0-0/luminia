# Requirements Document

## Introduction

Lumina is a mobile-first, anti-doomscroll knowledge feed application that replaces mindless social media scrolling with a curiosity-driven, evolving reading experience. Lumina aggregates content from six sources (Wikipedia, Medium, Hacker News, arXiv, MIT News, and Quanta Magazine) into a card-based feed. The feed learns from implicit reading behaviour (scroll depth, time-on-card, tap-to-expand, link-out events) in addition to explicit preferences, surfaces emerging interests, and is deliberately designed to resist infinite-scroll addiction.

This document specifies the functional and quality requirements for Lumina across the following capability areas: authentication and account management, onboarding, content ingestion, feed ranking and personalization, implicit signal collection, preference model learning, anti-doomscroll product constraints, the in-app reader, library and collections, search, profile and insights, and notification hygiene.

The anti-doomscroll behaviours are first-class product requirements, not optional user settings.

## Glossary

- **Lumina**: The complete application comprising the mobile client, backend API, and ingestion services.
- **Mobile_App**: The React Native (Expo) client application.
- **Auth_Service**: The backend component that handles registration, login, OAuth, session tokens, and session termination.
- **Onboarding_Service**: The backend component that serves the topic taxonomy and persists onboarding selections.
- **Feed_Service**: The backend component that assembles and serves paginated feed responses.
- **Ranking_Engine**: The backend component that computes a relevance score for each candidate article relative to a user.
- **Signal_Collector**: The Mobile_App component that captures implicit reading behaviour events and batches them for transmission.
- **Feed_Event_Service**: The backend component that receives, validates, and stores batched behaviour events.
- **Preference_Model_Updater**: The scheduled backend job that recomputes user embeddings, topic weights, and emerging topics.
- **Ingestion_Pipeline**: The backend service that orchestrates crawling, deduplication, scoring, summarization, embedding, and storage of articles.
- **Crawler**: An ingestion component that fetches raw content from a single external source.
- **Deduplicator**: The ingestion component that removes duplicate articles by URL hash.
- **Quality_Scorer**: The ingestion component that assigns a quality score to each article.
- **Summarizer**: The ingestion component that generates a summary, tags, difficulty, and read time using the Claude API.
- **Embedder**: The ingestion component that generates a vector embedding for each article.
- **Read_Time_Estimator**: The ingestion component that estimates reading time in minutes for an article.
- **Scheduler**: The ingestion component that triggers crawls on a recurring schedule.
- **Reader**: The Mobile_App article reading screen that renders article full text.
- **Library_Service**: The backend component that manages saved articles and collections.
- **Search_Service**: The backend component that provides full-text search over ingested articles via Typesense.
- **Insights_Service**: The backend component that computes reading statistics, topic breakdowns, and emerging interests.
- **Notification_Service**: The backend component that manages push notification delivery.
- **Session_Manager**: The Mobile_App component that enforces anti-doomscroll constraints such as the soft feed end and session timer.
- **Article**: A single ingested content item with metadata, summary, full text, and embedding.
- **Topic**: A taxonomy entry that classifies articles and user interests, optionally nested via a parent reference.
- **Source**: An external content provider; one of Wikipedia, Medium, Hacker News, arXiv, MIT News, or Quanta Magazine.
- **User_Embedding**: A 1536-dimension vector representing a user's aggregate reading interests.
- **Feed_Event**: A recorded implicit or explicit behaviour signal of type impression, dwell, expand, scroll_depth, save, unsave, share, link_out, skip, mute_topic, or session_end.
- **Serendipity_Card**: A feed card drawn from a Topic far from the user's interest centroid, presented to introduce novelty.
- **Daily_Goal**: A user-configured reading target expressed in minutes per day.
- **Depth_Preference**: A user setting of quick, balanced, or deep that biases article read-time selection.

## Requirements

### Requirement 1: User Registration

**User Story:** As a new user, I want to create an account with my email or a supported OAuth provider, so that I can access a personalized feed.

#### Acceptance Criteria

1. WHEN a registration request with a unique email in a valid format and a password of at least 8 and at most 128 characters is received, THE Auth_Service SHALL create a user account and return an authenticated session token.
2. IF a registration request contains an email that already exists, THEN THE Auth_Service SHALL reject the request and return a conflict error identifying the email as already registered.
3. IF a registration request contains an email that does not match a valid email format or exceeds 254 characters, THEN THE Auth_Service SHALL reject the request, return a validation error, and SHALL NOT create a user account.
4. IF a registration request contains a password shorter than 8 characters or longer than 128 characters, THEN THE Auth_Service SHALL reject the request, return a validation error indicating the password length requirement, and SHALL NOT create a user account.
5. WHEN an OAuth registration request is received for the google or apple provider and the provider identity is verified, THE Auth_Service SHALL link the provider identity to an existing account whose email matches the provider-supplied email, or otherwise create a new user account, and return an authenticated session token.
6. IF an OAuth registration request specifies a provider other than google or apple, or the provider identity cannot be verified, THEN THE Auth_Service SHALL reject the request, return an error indicating the OAuth registration could not be completed, and SHALL NOT create or link a user account.
7. WHERE a registration request specifies a Daily_Goal between 5 and 120 minutes inclusive, THE Auth_Service SHALL create the account with the specified Daily_Goal.
8. IF a registration request specifies a Daily_Goal outside the range of 5 to 120 minutes inclusive, THEN THE Auth_Service SHALL reject the request and return a validation error indicating the allowed Daily_Goal range.
9. WHERE a registration request omits the Daily_Goal or the Depth_Preference, THE Auth_Service SHALL set the omitted Daily_Goal to a default of 15 minutes and the omitted Depth_Preference to balanced.

### Requirement 2: User Authentication and Session Management

**User Story:** As a returning user, I want to log in and maintain a session, so that I can continue using Lumina without repeated sign-in.

#### Acceptance Criteria

1. WHEN a login request with valid credentials is received, THE Auth_Service SHALL return an access token valid for 15 minutes and a refresh token valid for 30 days.
2. IF a login request contains credentials that do not match an existing account, THEN THE Auth_Service SHALL reject the request and return a generic authentication error that does not indicate whether the email or the password was incorrect.
3. WHEN a refresh request with a valid, non-expired refresh token is received, THE Auth_Service SHALL issue a new access token valid for 15 minutes.
4. IF a refresh request contains an expired, malformed, or invalidated refresh token, THEN THE Auth_Service SHALL reject the request and return a generic authentication error.
5. WHEN a logout request is received with a valid access token, THE Auth_Service SHALL invalidate both the access token and its associated refresh token such that any subsequent request presenting either token is rejected.
6. IF a request to a protected route is received with a missing, malformed, expired, or invalidated access token, THEN THE Auth_Service SHALL reject the request and return a generic authorization error.
7. IF 5 consecutive login requests for the same account fail within a 15-minute window, THEN THE Auth_Service SHALL lock that account for 15 minutes and reject any further login request for that account during the lockout period with a generic authentication error.

### Requirement 3: Onboarding Topic Taxonomy

**User Story:** As a new user, I want to choose topics that interest me during onboarding, so that my initial feed reflects my curiosity.

#### Acceptance Criteria

1. WHEN a request for the topic taxonomy is received, THE Onboarding_Service SHALL return the available Topic list including slug, label, parent reference, color, and icon name for each Topic.
2. IF an onboarding completion request contains fewer than 3 or more than 20 selected topic identifiers, THEN THE Onboarding_Service SHALL reject the request, persist no onboarding selections, and return a validation error indicating that between 3 and 20 topics are required.
3. IF an onboarding completion request contains one or more selected topic identifiers that do not reference an existing Topic, THEN THE Onboarding_Service SHALL reject the request, persist no onboarding selections, and return a validation error identifying the unrecognized topic identifiers.
4. IF an onboarding completion request contains a Depth_Preference that is not one of quick, balanced, or deep, or a Daily_Goal that is not a positive integer between 5 and 120 minutes inclusive, THEN THE Onboarding_Service SHALL reject the request, persist no onboarding selections, and return a validation error identifying the invalid field.
5. WHEN an onboarding completion request with between 3 and 20 valid topic identifiers each referencing an existing Topic, a Depth_Preference of quick, balanced, or deep, and a Daily_Goal between 5 and 120 minutes inclusive is received, THE Onboarding_Service SHALL persist each distinct selected Topic with source inferred as onboarding and an initial weight of 1.0.
6. WHEN an onboarding completion request is persisted, THE Onboarding_Service SHALL store the provided Depth_Preference and Daily_Goal on the user account.
7. WHERE a source toggle selection is provided during onboarding, THE Onboarding_Service SHALL persist the enabled or disabled state for each Source included in the selection for the user.

### Requirement 4: Onboarding Flow and First Feed

**User Story:** As a new user, I want a guided onboarding flow that ends with a ready-to-read feed, so that I can start using Lumina immediately.

#### Acceptance Criteria

1. WHILE a user has no persisted onboarding selections, THE Mobile_App SHALL route the user to the onboarding flow rather than the main feed.
2. WHILE fewer than 3 topics are selected on the topic picker step, THE Mobile_App SHALL keep the advance control disabled.
3. WHILE no Depth_Preference of quick, balanced, or deep is selected on the depth preference step, THE Mobile_App SHALL keep the advance control disabled until exactly one Depth_Preference is selected.
4. WHERE the source selection step is presented, THE Mobile_App SHALL enable all six Sources (Wikipedia, Medium, Hacker News, arXiv, MIT News, and Quanta Magazine) by default.
5. WHEN the user skips the source selection step, THE Mobile_App SHALL retain all six Sources in the enabled state.
6. WHEN onboarding selections are submitted, THE Feed_Service SHALL assemble and return an initial ranked feed batch of up to 20 ranked Articles together with a next-page cursor.
7. IF feed assembly fails when onboarding selections are submitted, THEN THE Feed_Service SHALL return an error indicating that the initial feed could not be assembled and SHALL preserve the persisted onboarding state.

### Requirement 5: Content Ingestion from Sources

**User Story:** As a reader, I want Lumina to continuously aggregate content from multiple trusted sources, so that my feed has fresh and varied material.

#### Acceptance Criteria

1. THE Ingestion_Pipeline SHALL ingest articles from Wikipedia, Medium, Hacker News, arXiv, MIT News, and Quanta Magazine.
2. WHEN a Crawler retrieves a content item, THE Ingestion_Pipeline SHALL process the item through deduplication, quality scoring, summarization, embedding, and storage in sequence.
3. WHEN the Scheduler triggers a crawl cycle and a previous successful crawl exists for the corresponding Source, THE Crawler for that Source SHALL fetch content items published since the previous successful crawl for that Source.
4. WHEN the Scheduler triggers a crawl cycle and no previous successful crawl exists for the corresponding Source, THE Crawler for that Source SHALL fetch content items published within the 24-hour backfill window immediately preceding the crawl cycle.
5. THE Scheduler SHALL trigger the Wikipedia crawl at an hourly interval, the Hacker News crawl at a 15-minute interval, and the Medium, arXiv, MIT News, and Quanta Magazine crawls at a 6-hour interval.
6. IF a Crawler does not receive a successful response from its Source within 30 seconds, OR receives an error response from its Source, THEN THE Ingestion_Pipeline SHALL record a failure entry that identifies the affected Source and SHALL continue crawling and processing the remaining sources.
7. IF recording a Crawler failure entry does not succeed, THEN THE Ingestion_Pipeline SHALL continue crawling and processing the remaining sources.

### Requirement 6: Article Deduplication and Quality Scoring

**User Story:** As a reader, I want duplicate and low-quality content filtered out, so that my feed stays clean and worthwhile.

#### Acceptance Criteria

1. WHEN the Deduplicator evaluates an incoming Article, THE Deduplicator SHALL compute a hash of the Article URL and compare it against the URL hashes of all stored Articles.
2. IF the computed URL hash matches the URL hash of any stored Article, THEN THE Deduplicator SHALL discard the incoming Article without persisting it and record the incoming Article as a rejected duplicate.
3. THE Quality_Scorer SHALL assign each Article a quality score in the range 0.0 to 1.0 inclusive, derived from content length, reading level, and source tier.
4. IF an Article is assigned a quality score below 0.3, THEN THE Quality_Scorer SHALL reject the Article and prevent it from being stored.
5. WHEN an Article is stored, THE Ingestion_Pipeline SHALL persist the Article with a unique URL, source reference, title, summary, cleaned full text, embedding vector, quality score, and ingestion timestamp.
6. WHERE an Article lacks an estimated read time, THE Read_Time_Estimator SHALL compute a read time expressed as a whole number of minutes with a minimum value of 1 before the Article is stored.

### Requirement 7: Article Summarization and Tagging

**User Story:** As a reader, I want each article to have a concise summary and accurate topic tags, so that I can decide what to read at a glance.

#### Acceptance Criteria

1. WHEN the Summarizer processes an Article, THE Summarizer SHALL return a summary of 2 to 3 sentences, between 1 and 4 tags drawn from the topic taxonomy, a difficulty of introductory, intermediate, or advanced, and a read time between 1 and 120 minutes.
2. WHEN the Summarizer returns tags for an Article, THE Ingestion_Pipeline SHALL associate the Article with the corresponding Topics, recording a confidence value between 0.0 and 1.0 for each association.
3. IF the Summarizer returns a response that does not conform to the required JSON structure, THEN THE Ingestion_Pipeline SHALL reject the summarization result, retain the Article in an unsummarized state, and retry summarization up to a maximum of 3 attempts.
4. IF summarization does not succeed within 3 attempts, THEN THE Ingestion_Pipeline SHALL retain the Article in an unsummarized state and stop further summarization attempts.
5. THE Embedder SHALL generate a 1536-dimension embedding vector for each Article before the Article is stored.
6. IF embedding generation for an Article does not succeed, THEN THE Ingestion_Pipeline SHALL retry embedding generation up to a maximum of 3 attempts and SHALL block storage of the Article until embedding generation succeeds or the maximum number of attempts is reached.
7. IF embedding generation does not succeed within 3 attempts, THEN THE Ingestion_Pipeline SHALL not store the Article and SHALL log the embedding failure.

### Requirement 8: Feed Assembly and Pagination

**User Story:** As a reader, I want a paginated feed I can scroll through, so that I can browse content smoothly.

#### Acceptance Criteria

1. WHEN a feed request is received with an authenticated user, THE Feed_Service SHALL return a ranked list of between 1 and 20 articles, a next-page cursor, and a feed version identifier.
2. WHEN a feed request includes a valid cursor, THE Feed_Service SHALL return the next page of between 1 and 20 articles following the position identified by the cursor, excluding any Article already returned in a preceding page of the same feed version.
3. WHEN a feed request includes a tab parameter of foryou, THE Feed_Service SHALL rank candidate articles using the personalized Ranking_Engine score.
4. WHEN a feed request includes a tab parameter equal to an existing Topic slug, THE Feed_Service SHALL restrict candidate articles to those associated with the specified Topic.
5. WHEN a request for active feed tabs is received, THE Feed_Service SHALL return a foryou tab followed by between 1 and 10 Topic tabs ordered by descending current topic weight, including only Topics whose weight is greater than 0.
6. WHEN the Feed_Service assembles a feed response, THE Feed_Service SHALL exclude any Article against which the user has previously recorded a skip Feed_Event.
7. IF a feed request includes a cursor that is malformed, expired, or does not correspond to a known feed position, THEN THE Feed_Service SHALL reject the request and return a validation error indicating the cursor is invalid, without returning feed articles.
8. IF a feed request includes a tab parameter that is neither foryou nor an existing Topic slug, THEN THE Feed_Service SHALL reject the request and return a validation error indicating the tab is invalid, without returning feed articles.

### Requirement 9: Feed Ranking Algorithm

**User Story:** As a reader, I want my feed ordered by what matters to me while still surfacing fresh and diverse content, so that the experience feels personal and not repetitive.

#### Acceptance Criteria

1. WHEN the Ranking_Engine scores a candidate Article for a user, THE Ranking_Engine SHALL compute the Article score as the weighted sum of its relevance, novelty, quality, recency, diversity, and serendipity components, where each component is normalized to a value between 0.0 and 1.0 and the resulting score is between 0.0 and 1.0.
2. THE Ranking_Engine SHALL compute the relevance component as the cosine similarity between the User_Embedding and the Article embedding, linearly normalized from its native range of -1.0 to 1.0 onto a value between 0.0 and 1.0.
3. THE Ranking_Engine SHALL compute the recency component as an exponential decay of the Article age in hours with a half-life of 24 hours, yielding 1.0 at an age of 0 hours and decreasing toward 0.0 as the age increases.
4. THE Ranking_Engine SHALL apply default component weights of 0.35 for relevance, 0.20 for novelty, 0.20 for quality, 0.15 for recency, 0.05 for diversity, and 0.05 for serendipity.
5. WHILE assembling a feed session, THE Ranking_Engine SHALL add a diversity bonus between 0.0 and 0.20 to the diversity component for an Article whose Source has supplied fewer cards in the current session than the average number of cards per enabled Source, and SHALL cap the diversity component at 1.0.
6. WHERE per-user weight tuning is enabled, THE Ranking_Engine SHALL increase the relevance weight for topics the user has engaged with by a simplified bandit adjustment between 0.0 and 0.15 and SHALL re-normalize the component weights so that they continue to sum to 1.0.
7. IF a user has no User_Embedding, THEN THE Ranking_Engine SHALL compute the relevance component from the match between the Article's associated Topics and the user's selected onboarding Topics, normalized to a value between 0.0 and 1.0, in place of the cosine similarity.

### Requirement 10: Serendipity Slot

**User Story:** As a reader, I want to occasionally encounter content outside my established interests, so that I can discover topics I did not know I cared about.

#### Acceptance Criteria

1. WHEN the Feed_Service assembles a feed sequence, THE Feed_Service SHALL insert exactly one Serendipity_Card at each card position that is a multiple of 10 (the 10th, 20th, 30th, and every subsequent position that is a multiple of 10).
2. WHEN selecting a Serendipity_Card, THE Ranking_Engine SHALL choose an Article from a Topic the user has never interacted with, where a Topic the user has never interacted with is defined as a Topic for which the user has no recorded Feed_Event against any associated Article.
3. IF no Topic exists for which the user has no recorded Feed_Event against any associated Article, THEN THE Ranking_Engine SHALL select an Article from the Topic whose centroid is farthest from the User_Embedding.
4. WHEN a Serendipity_Card is returned, THE Mobile_App SHALL display a "Something new" pill on the card.

### Requirement 11: Related Articles via Vector Similarity

**User Story:** As a reader finishing an article, I want a small set of high-quality related articles, so that I can go deeper without falling into a rabbit hole.

#### Acceptance Criteria

1. WHEN a request for related articles for a stored Article is received, THE Feed_Service SHALL return up to 5 distinct articles ordered by descending cosine similarity between each candidate Article embedding and the source Article embedding.
2. WHEN related articles are returned, THE Feed_Service SHALL exclude the source Article from the related set.
3. IF fewer than 5 candidate articles remain after excluding the source Article, THEN THE Feed_Service SHALL return all remaining candidate articles, including an empty set when no candidate articles remain.
4. IF a related articles request references a source Article that does not exist, THEN THE Feed_Service SHALL reject the request and return an error indicating that the source Article was not found.

### Requirement 12: Implicit Signal Collection

**User Story:** As a reader, I want Lumina to learn from how I read rather than only from explicit choices, so that my feed improves automatically.

#### Acceptance Criteria

1. WHEN an Article card becomes at least 50% visible within the viewport, THE Signal_Collector SHALL record an impression Feed_Event for that Article.
2. WHILE an Article card remains at least 50% visible within the viewport, THE Signal_Collector SHALL track the elapsed dwell duration for that Article in milliseconds.
3. WHEN a user taps to expand an Article card, THE Signal_Collector SHALL record an expand Feed_Event for that Article.
4. IF an Article card exits the viewport within 1500 milliseconds of becoming at least 50% visible, THEN THE Signal_Collector SHALL record a skip Feed_Event for that Article.
5. WHEN an Article card exits the viewport after having remained at least 50% visible for 1500 milliseconds or longer, THE Signal_Collector SHALL record exactly one dwell Feed_Event capturing the tracked dwell duration in milliseconds.
6. WHEN the maximum proportion of an Article scrolled in the Reader increases by 0.25 on a scale of 0.0 to 1.0, THE Signal_Collector SHALL record a scroll_depth Feed_Event capturing the new maximum scrolled proportion.
7. WHEN a user opens an external link from an Article, THE Signal_Collector SHALL record a link_out Feed_Event for that Article.
8. WHEN 30 seconds have elapsed since the previous transmission attempt, THE Signal_Collector SHALL transmit accumulated Feed_Events to the Feed_Event_Service in one or more batches, each containing at most 200 Feed_Events.
9. IF the Feed_Event_Service does not acknowledge a transmitted batch within 10 seconds, THEN THE Signal_Collector SHALL treat that transmission as failed, retain the unacknowledged Feed_Events, and retry transmission of that batch.
10. THE Signal_Collector SHALL persist unacknowledged Feed_Events in local storage so that they are retained across application restarts and transmitted once connectivity is restored.
11. IF recording a new Feed_Event would cause the local Feed_Event buffer to exceed 1000 events, THEN THE Signal_Collector SHALL evict the oldest stored Feed_Event before storing the new one.

### Requirement 13: Signal Event Ingestion

**User Story:** As a product owner, I want behaviour events reliably stored, so that personalization has accurate data to learn from.

#### Acceptance Criteria

1. WHEN a batch of no more than 500 Feed_Events is received, THE Feed_Event_Service SHALL persist each valid event in the batch with its user reference, article reference, event type, payload, and occurrence timestamp.
2. IF a Feed_Event in a batch specifies an event type outside the set impression, dwell, expand, scroll_depth, save, unsave, share, link_out, skip, mute_topic, and session_end, THEN THE Feed_Event_Service SHALL reject that event while persisting the remaining valid events in the batch, and return a validation error identifying each rejected event.
3. WHEN a batch of Feed_Events is processed, THE Feed_Event_Service SHALL return an acknowledgement to the Mobile_App that identifies the count of events persisted and the count of events rejected.
4. IF a Feed_Event in a batch has the same client-supplied event identifier as a previously persisted Feed_Event, THEN THE Feed_Event_Service SHALL discard the duplicate without creating an additional stored record and SHALL acknowledge the event as already received.
5. IF a received batch contains more than 500 Feed_Events, THEN THE Feed_Event_Service SHALL reject the entire batch, persist no events from the batch, and return a validation error indicating the maximum batch size was exceeded.

### Requirement 14: Preference Model Update

**User Story:** As a reader, I want my interest profile to evolve based on my recent reading, so that the feed reflects my current curiosity.

#### Acceptance Criteria

1. THE Preference_Model_Updater SHALL execute at a recurring interval of 6 hours.
2. WHEN the Preference_Model_Updater runs for a user, THE Preference_Model_Updater SHALL evaluate Feed_Events recorded within the 30-day window that ends at the execution start time of the run.
3. WHEN computing a user's interest signal, THE Preference_Model_Updater SHALL weight each event type as impression 0.05, dwell 0.15, expand 0.35, scroll_depth 0.10 multiplied by the recorded scroll proportion (a value from 0.0 to 1.0 inclusive), save 0.50, unsave 0.0, share 0.60, link_out 0.45, skip -0.20, session_end 0.0, and mute_topic -1.00.
4. WHEN computing the new User_Embedding, THE Preference_Model_Updater SHALL build a recency-weighted centroid of the embeddings of engaged articles, where an engaged article is one whose net weighted signal over the 30-day window is greater than 0.0, and persist the result to the user embedding record.
5. WHILE building the recency-weighted centroid, THE Preference_Model_Updater SHALL assign each engaged article a recency weight such that, between two engaged articles with equal net weighted signal, the article whose most recent Feed_Event occurred later contributes a strictly greater weight to the centroid.
6. WHEN the User_Embedding is updated, THE Preference_Model_Updater SHALL recompute each topic weight from the similarity between the User_Embedding and the corresponding topic centroid and SHALL clamp each recomputed topic weight to the range 0.0 to 2.0 inclusive.
7. WHEN evaluating topic trends, THE Preference_Model_Updater SHALL record a topic as emerging IF its aggregate signal over the most recent 7 days exceeds its aggregate signal over the preceding 7 days by 20% or more, OR IF its aggregate signal over the preceding 7 days is 0.0 or less and its aggregate signal over the most recent 7 days is greater than 0.0.
8. IF a user has no Feed_Events in both the most recent 7 days and the preceding 7 days, THEN THE Preference_Model_Updater SHALL record that no topics are emerging.
9. IF a user has no Feed_Events in the entire 30-day window, THEN THE Preference_Model_Updater SHALL leave the User_Embedding and all topic weights unchanged.

### Requirement 15: Soft Feed End

**User Story:** As a reader, I want a natural stopping point in my feed, so that I am not pulled into endless scrolling.

#### Acceptance Criteria

1. WHEN the user opens the feed view, THE Session_Manager SHALL begin a new feed session and set the session viewed-card count to 0.
2. WHEN the number of Article cards that have entered the viewport during the current feed session reaches 30, THE Session_Manager SHALL present a session-end screen that displays the reading time accumulated during the current feed session expressed in minutes.
3. WHILE the session-end screen is displayed, THE Session_Manager SHALL prevent additional Article cards from loading.
4. WHEN the user taps the "Keep going" control, THE Session_Manager SHALL dismiss the session-end screen, reset the session viewed-card count to 0, and resume loading feed cards.
5. WHEN the user exits the feed view, THE Session_Manager SHALL end the current feed session.

### Requirement 16: Session Timer and Daily Goal Awareness

**User Story:** As a reader, I want gentle awareness of my reading progress toward my goal, so that I can find a natural stopping point without pressure.

#### Acceptance Criteria

1. WHILE an Article is open in the Reader, THE Session_Manager SHALL accumulate reading time and update the progress arc around the profile avatar tab icon at most once every 60 seconds, filling the arc to a value equal to accumulated reading time divided by the Daily_Goal, capped at 100%.
2. WHEN accumulated reading time for the day reaches the Daily_Goal, THE Mobile_App SHALL present the Daily_Goal as achieved by displaying the progress arc fully filled together with a visible achieved indication, while permitting unrestricted reading.
3. THE Session_Manager SHALL present the Daily_Goal as a reading target and SHALL NOT block, pause, delay, or hide content based on the Daily_Goal being reached or exceeded.
4. WHEN device local time reaches 00:00, THE Session_Manager SHALL reset accumulated reading time to zero and clear the progress arc to empty.
5. WHILE accumulated reading time for the day is at or above the Daily_Goal, THE Session_Manager SHALL keep the progress arc fully filled without wrapping until the next daily reset at 00:00 device local time.

### Requirement 17: Non-Addictive Presentation Constraints

**User Story:** As a reader, I want a calm interface free of addictive mechanics, so that my attention is respected.

#### Acceptance Criteria

1. WHEN an Article card is displayed, THE Mobile_App SHALL show the Article's read-time estimate in whole minutes and the Source name.
2. THE Mobile_App SHALL omit all engagement counts, including like counts, view counts, follower counts, comment counts, share counts, and reaction counts, from every Article card.
3. THE Mobile_App SHALL render media without automatic playback, including no auto-playing video, no auto-playing audio, and no auto-advancing carousels.
4. WHEN a user explicitly activates a media element, THE Mobile_App SHALL play only that activated media element.

### Requirement 18: Notification Hygiene

**User Story:** As a reader, I want minimal, respectful notifications, so that Lumina does not interrupt me.

#### Acceptance Criteria

1. WHEN a user account is created, THE Notification_Service SHALL set push notifications to disabled by default.
2. WHERE a user has enabled push notifications, THE Notification_Service SHALL send no more than 1 push notification to that user within any 24-hour period.
3. WHEN the Notification_Service sends the daily notification, THE Notification_Service SHALL deliver the message "Your curiosity feed has new picks."
4. IF a user has push notifications disabled, THEN THE Notification_Service SHALL NOT send any push notification to that user.

### Requirement 19: In-App Reader

**User Story:** As a reader, I want a clean, distraction-free reading view, so that I can focus on the content.

#### Acceptance Criteria

1. WHEN a user opens an Article that has stored full text in the Reader, THE Reader SHALL render the cleaned full text using the Lumina typography and SHALL exclude all advertisements from the rendered Article.
2. WHILE the device or app is in dark mode, THE Reader SHALL apply dark-mode styling to the rendered Article.
3. WHILE a user scrolls within the Reader, THE Reader SHALL report the scroll depth as a proportion between 0.0 and 1.0 to the Signal_Collector.
4. WHEN the Reader is displayed for an Article and at least 3 related articles are available, THE Reader SHALL present a "Go deeper" section containing all available related articles up to a maximum of 5.
5. IF fewer than 3 related articles are available for an Article, THEN THE Reader SHALL omit the "Go deeper" section.
6. IF a user opens an Article that has no stored full text, THEN THE Reader SHALL omit the rendered full text and present a control that opens the Article source in an external browser.

### Requirement 20: Article Detail and Search

**User Story:** As a reader, I want to view full article detail and search the catalog, so that I can find specific content.

#### Acceptance Criteria

1. WHEN a request for an existing Article detail is received, THE Feed_Service SHALL return the full Article detail together with related articles.
2. IF a request references an Article that does not exist, THEN THE Feed_Service SHALL return an error indicating the Article was not found and SHALL NOT return any partial Article detail.
3. IF related articles cannot be retrieved for an existing Article detail request, THEN THE Feed_Service SHALL return the Article detail without related articles.
4. WHEN a search request with a query string of 1 to 200 characters is received, THE Search_Service SHALL return matching articles ordered by descending full-text relevance.
5. IF a search request contains a query that is empty, whitespace-only, or exceeds 200 characters, THEN THE Search_Service SHALL reject the request with a validation error indicating the query is invalid and SHALL NOT perform the search.
6. WHEN a valid search request matches no articles, THE Search_Service SHALL return an empty result set.
7. WHERE a search request includes one or more filters for source, topic, read-time, or date-range, THE Search_Service SHALL restrict results to articles matching all of the specified filters.
8. WHEN a user performs a search with a non-empty query, THE Mobile_App SHALL store the query in local search history, retaining at most the 50 most recent unique queries and evicting the oldest query first when the limit is exceeded.

### Requirement 21: Library and Saves

**User Story:** As a reader, I want to save articles and mark them read, so that I can return to content I value.

#### Acceptance Criteria

1. WHEN a user saves an Article that is not already in the user's library, THE Library_Service SHALL add the Article to the library with an initial read state of unread and record a save Feed_Event.
2. WHEN a user removes an Article that is currently in the user's library, THE Library_Service SHALL remove the Article from the library and record an unsave Feed_Event.
3. WHEN a user updates the read state of a saved Article, THE Library_Service SHALL persist the read state as exactly one of the values read or unread.
4. WHEN a user requests the saved-articles list, THE Library_Service SHALL return at most 50 Articles per page with a next-page cursor, filterable by read state and by Source.
5. IF a user saves an Article that is already in the user's library, THEN THE Library_Service SHALL leave the Article and its read state unchanged and record no duplicate save Feed_Event.
6. IF a user unsaves an Article that is not in the user's library, THEN THE Library_Service SHALL reject the request with an error indicating the Article is not saved and record no unsave Feed_Event.

### Requirement 22: Collections

**User Story:** As a reader, I want to organize saved articles into collections, so that I can group content by theme.

#### Acceptance Criteria

1. WHEN a request to create a collection is received with a name between 1 and 100 characters, THE Library_Service SHALL create the collection for the user with the provided name, color, and icon.
2. WHEN a request to add a saved Article to a collection is received, THE Library_Service SHALL associate the Article with the specified collection.
3. WHEN a request to update a collection is received, THE Library_Service SHALL apply the requested change to the user's collection.
4. WHEN a request to delete a collection is received, THE Library_Service SHALL remove the collection and its Article associations while retaining the underlying saved Articles in the user's library.
5. WHEN a request for a collection's contents is received, THE Library_Service SHALL return a paginated list of the Articles associated with that collection.
6. IF a request is received to add an Article that is not saved in the user's library to a collection, THEN THE Library_Service SHALL reject the request with an error indicating the Article must be saved first and SHALL leave the collection unchanged.
7. IF a request to update, add to, or delete a collection that belongs to another user is received, THEN THE Library_Service SHALL reject the request with an authorization error and SHALL leave the collection unchanged.

### Requirement 23: Feed Card Interactions

**User Story:** As a reader, I want fast gesture-based controls on each card, so that I can act on content without friction.

#### Acceptance Criteria

1. WHEN a user swipes left on an Article card, THE Mobile_App SHALL dismiss the card from the current feed session and record a skip Feed_Event for that Article.
2. WHEN a user presses and holds an Article card for 500 milliseconds or longer, THE Mobile_App SHALL present an action sheet containing the options save, share, mute topic, and open source.
3. WHEN a user taps an Article card with a press duration shorter than 500 milliseconds, THE Mobile_App SHALL open the associated Article in the Reader.
4. WHEN a user selects mute topic from the action sheet, THE Feed_Event_Service SHALL record a mute_topic Feed_Event for the Topic with the highest association confidence for that Article.
5. WHEN a user selects share from the action sheet, THE Mobile_App SHALL present the system share sheet for the Article and record a share Feed_Event for that Article.
6. WHEN a user selects open source from the action sheet, THE Mobile_App SHALL open the Article's external source location and record a link_out Feed_Event for that Article.

### Requirement 24: Profile and Insights

**User Story:** As a reader, I want to see how my reading and interests are evolving, so that I can understand and shape my curiosity.

#### Acceptance Criteria

1. WHEN an insights request is received, THE Insights_Service SHALL return the count of articles read in the current calendar month, the total quality reading time in whole minutes for the current calendar month excluding skip events, and the count of newly discovered topics first engaged with in the current calendar month.
2. WHEN an insights request is received, THE Insights_Service SHALL return a per-topic interest breakdown sorted by descending weight, labelling each Topic as growing when its 7-day signal increased more than 10%, fading when its 7-day signal decreased more than 10%, and steady when its 7-day signal changed within plus or minus 10%.
3. WHEN an insights request is received, THE Insights_Service SHALL return a source breakdown of reading time per Source in whole minutes for the current calendar month.
4. WHEN at least one emerging topic is detected, THE Insights_Service SHALL return up to 3 emerging interest topics that are detected but not yet explicitly added by the user.
5. WHEN a user accepts an emerging interest Topic that is a member of the user's current emerging topic list, THE Insights_Service SHALL add the Topic to the user's topics with source inferred and remove the Topic from the emerging topic list.
6. IF a user accepts a Topic that is not in the user's current emerging topic list, THEN THE Insights_Service SHALL return an error indicating that no such emerging topic is available and SHALL leave state unchanged.
7. WHEN an insights request is received, THE Insights_Service SHALL return a feed evolution narrative bounded to between 1 and 3 sentences describing the shift in the user's reading attention.
8. IF the user has no reading history, THEN THE Insights_Service SHALL return insights with zero counts and empty breakdowns.
9. IF no emerging topics are detected, THEN THE Insights_Service SHALL return an empty emerging topics list.
10. IF the user has no reading history, THEN THE Insights_Service SHALL return a narrative indicating that there is insufficient reading history.

### Requirement 25: Topic Weight Management and Muting

**User Story:** As a reader, I want control over which topics influence my feed, so that I can steer my experience.

#### Acceptance Criteria

1. WHEN a request for current topic weights is received, THE Insights_Service SHALL return each Topic associated with the user, its current weight, and whether the Topic is currently muted.
2. WHEN a user mutes a Topic, THE Feed_Service SHALL persist the muted state and exclude articles associated with that Topic from feed responses in the current session and all subsequent sessions until the Topic is unmuted.
3. WHEN a user unmutes a previously muted Topic, THE Feed_Service SHALL persist the unmuted state and allow articles associated with that Topic in feed responses in the current session and all subsequent sessions until the Topic is muted again.
4. IF a user mutes a Topic that is already muted, THEN THE Feed_Service SHALL preserve the Topic's muted state and return a success acknowledgement.
5. IF a user unmutes a Topic that is not currently muted, THEN THE Feed_Service SHALL preserve the Topic's unmuted state and return a success acknowledgement.
6. IF a user mutes or unmutes a Topic that does not exist for the user, THEN THE Feed_Service SHALL reject the request and return an error indicating the Topic was not found.

### Requirement 26: Profile Management

**User Story:** As a user, I want to view and update my profile and preferences, so that Lumina reflects my current settings.

#### Acceptance Criteria

1. WHEN a request for the current user profile is received with a valid access token, THE Auth_Service SHALL return the user's display name, avatar, Depth_Preference, and Daily_Goal.
2. WHEN a request to update the user profile is received with a valid access token, and where included a display name of 1 to 50 characters, a Daily_Goal between 5 and 120 minutes inclusive, and a Depth_Preference of quick, balanced, or deep, THE Auth_Service SHALL persist the provided values for display name, Depth_Preference, and Daily_Goal.
3. IF a profile update request contains a display name outside the range of 1 to 50 characters, a Daily_Goal outside the range of 5 to 120 minutes inclusive, or a Depth_Preference outside the values quick, balanced, or deep, THEN THE Auth_Service SHALL reject the request, leave the stored profile unchanged, and return a validation error identifying the field that failed.
4. IF a request to view or update the user profile is received without a valid access token, THEN THE Auth_Service SHALL reject the request and return an authorization error.

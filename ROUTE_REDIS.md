# Detailed Redis Guide for `src/route.ts`

This document describes how `src/route.ts` uses Redis: keys, data types, Redis commands, timings, example requests, and operational notes.

See the source: [src/route.ts](src/route.ts)

## Overview

`src/route.ts` exposes HTTP endpoints that demonstrate common Redis patterns:
- simple string storage (`SET`, `GET`)
- TTL-backed caching (`SETEX`, `TTL`)
- hashes for structured objects (`HSET`, `HGETALL`)
- lists for job queues (`LPUSH`, `RPOP`, `LRANGE`)
- sorted sets for leaderboards (`ZADD`, `ZINCRBY`, `ZRANGE/ZREVRANGE`)
- Pub/Sub for realtime messaging (`PUBLISH`, `SUBSCRIBE`)
- atomic counters + expiry for rate-limiting (`INCR`, `EXPIRE`)

A dedicated `subscriber` client is created with `createClient({ url: "redis://localhost:6379" })` and used for subscription via Server-Sent Events (SSE). The main `client` (imported from `redisClient`) handles the other commands.

## Connection notes

- The file creates and connects a `subscriber` with a direct URL. Consider switching to an environment variable (e.g. `REDIS_URL`) for production:

  ```ts
  const subscriber = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
  await subscriber.connect();
  ```

- Keep one client for commands and one dedicated client for Pub/Sub. Pub/Sub clients cannot be used for normal command traffic while subscribed.

## Endpoint reference (route → Redis details)

- POST /set
  - Purpose: store a string value
  - Redis: `SET key value`
  - Body: `{ "key": "foo", "value": "bar" }`
  - Example curl:
    ```sh
    curl -X POST -H "Content-Type: application/json" -d '{"key":"k","value":"v"}' http://localhost:3000/set
    ```

- GET /get/:key
  - Purpose: retrieve a string
  - Redis: `GET <key>`
  - Example: `GET` via curl

- POST /set-ttl
  - Purpose: store a string with TTL
  - Redis: `SETEX key seconds value` (via `client.setEx`)
  - Body: `{ "key": "k", "value": "v", "seconds": 60 }`

- GET /ttl/:key
  - Purpose: return TTL in seconds
  - Redis: `TTL <key>`

- GET /user/:id
  - Purpose: cache database user lookup
  - Flow:
    1. Derive `cacheKey = user:<id>`
    2. Try `GET cacheKey` (string containing JSON)
    3. If cache miss, query SQLite `users` table and `SETEX cacheKey 30 <JSON(user)>`
  - Notes:
    - Cached entries expire after 30s (short-lived cache)
    - Stored as JSON-serialized string
  - Example curl (read):
    ```sh
    curl http://localhost:3000/user/42
    ```

- POST /user
  - Purpose: store a user as a Redis hash
  - Redis: `HSET user:<id> id <id> name <name> email <email>` (via `client.hSet`)
  - Body: `{ "id":"42", "name":"Alice", "email":"a@example.com" }`

- GET /user-hash/:id
  - Purpose: retrieve the Redis hash for a user
  - Redis: `HGETALL user:<id>` (via `client.hGetAll`)
  - If hash empty → 404

- PATCH /user-hash/:id
  - Purpose: update a single field in user hash
  - Redis: `HSET user:<id> <field> <value>`
  - Body: `{ "field": "email", "value": "new@example.com" }`

- POST /job
  - Purpose: push a job object into a queue
  - Redis: `LPUSH jobs:queue <jobJson>`
  - Job stored as stringified JSON
  - Example job body: `{ "type": "send-email", "payload": { ... } }`

- GET /jobs
  - Purpose: inspect queue contents without removing
  - Redis: `LRANGE jobs:queue 0 -1`
  - Returned as JSON array of job objects

- POST /job/pop
  - Purpose: pop one job from the tail
  - Redis: `RPOP jobs:queue`
  - Note: using `LPUSH` + `RPOP` produces FIFO semantics

- POST /leaderboard
  - Purpose: add or update a player's score
  - Redis: `ZADD leaderboard NX?` (code uses `zAdd` with score/value)
  - After add, `ZREVRANK` is used to get rank (descending)
  - Returned rank is `zRevRank + 1`
  - Body: `{ "player": "alice", "score": 123 }`

- POST /leaderboard/increment
  - Purpose: increment a player's score atomically
  - Redis: `ZINCRBY leaderboard <by> <player>` (`client.zIncrBy`)

- GET /leaderboard/top/:n
  - Purpose: return top N players with scores
  - Redis: `ZRANGE ... WITHSCORES` or client-side method `zRangeWithScores(..., { REV: true })`
  - Output: array of `{ rank, player, score }`

- GET /subscribe/:channel
  - Purpose: SSE endpoint that subscribes to a channel and streams messages
  - Redis: `SUBSCRIBE <channel>` using the `subscriber` client
  - Implementation notes:
    - Uses HTTP Server-Sent Events (SSE) headers to keep connection open
    - Writes `data: <message>\n\n` for each message
    - Cleans up with `subscriber.unsubscribe(channel)` on client disconnect

- POST /publish
  - Purpose: publish a message to a Pub/Sub channel
  - Redis: `PUBLISH <channel> <message>`
  - Body: `{ "channel": "chat", "message": "hello" }`

- GET /limited
  - Purpose: simple rate limiter per IP
  - Redis: `INCR ratelimit:<ip>` then `EXPIRE ratelimit:<ip> 10` on first hit
  - Logic:
    - If `INCR` returns 1 → set expiry 10s (window)
    - Limit is 5 requests per window
    - Headers: `X-RateLimit-Count`, `X-RateLimit-Limit`
    - If count > 5 → HTTP 429

## Key naming conventions used in the file

- `user:<id>` — used both as a JSON cache string (GET/SETEX) and as a hash (`HSET`/`HGETALL`). Be careful: two different types for the same key pattern can be confusing; recommended to use distinct prefixes for each representation, e.g. `user:json:<id>` and `user:hash:<id>`.
- `jobs:queue` — list used as a FIFO queue with `LPUSH` + `RPOP`.
- `leaderboard` — sorted set storing player scores with member = player name.
- `ratelimit:<ip>` — counter key per IP for rate-limiting.

## Data types mapping

- String: `SET`, `GET`, `SETEX`
- Hash: `HSET`, `HGETALL`, `HGET`, `HSET` (update fields)
- List: `LPUSH`, `RPOP`, `LRANGE`
- Sorted set: `ZADD`, `ZINCRBY`, `ZRANGE` / `ZREVRANGE`, `ZREVRANK`
- Pub/Sub: `PUBLISH`, `SUBSCRIBE`
- Key metadata: `TTL`, `EXPIRE`, `INCR`

## Debugging with redis-cli

- Inspect a key:
  ```sh
  redis-cli GET "user:42"
  redis-cli HGETALL "user:42"
  redis-cli LRANGE "jobs:queue" 0 -1
  redis-cli ZREVRANGE "leaderboard" 0 9 WITHSCORES
  redis-cli TTL "user:42"
  ```

- Manually publish:
  ```sh
  redis-cli PUBLISH chat "hello world"
  ```

## Example curl sequences

- Push a job and then pop it:
  ```sh
  curl -X POST -H "Content-Type: application/json" -d '{"type":"task","payload":{}}' http://localhost:3000/job
  curl -X POST http://localhost:3000/job/pop
  ```

- Add leaderboard score and get top 3:
  ```sh
  curl -X POST -H "Content-Type: application/json" -d '{"player":"bob","score":200}' http://localhost:3000/leaderboard
  curl http://localhost:3000/leaderboard/top/3
  ```

- Subscribe (SSE) with curl:
  ```sh
  curl -N http://localhost:3000/subscribe/chat
  # in another terminal
  curl -X POST -H "Content-Type: application/json" -d '{"channel":"chat","message":"hi"}' http://localhost:3000/publish
  ```

## Operational recommendations

- Use separate key prefixes for different representations of the same domain object (avoid `user:...` being both string and hash).
- Sanitize and/or limit message sizes for queue and pub/sub payloads to avoid memory pressure.
- Consider using Redis streams for more advanced durable consumer groups instead of simple lists.
- Add error handling around Redis operations (timeouts, reconnects) — current code assumes operations succeed.
- Use environment variables for the Redis connection string and authentication in production.
- Monitor memory usage and set sensible TTLs on ephemeral data.

## Suggested improvements in code

- Use consistent key prefixes: `user:cache:<id>` and `user:hash:<id>`.
- Wrap Redis calls with try/catch to return 5xx on Redis failures instead of throwing.
- Use `LPUSH` + `BRPOP` or Redis Streams if workers should block and wait for jobs.
- For rate limiting, use `INCR` + `EXPIRE` or Lua script to make it atomic (current flow is acceptable but be mindful of race conditions in other patterns).

---

If you want, I can:
- rename keys for clarity in the code,
- add error handling wrappers around Redis calls,
- or generate a short README section with deploy/run steps.

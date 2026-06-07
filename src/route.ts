import { Router } from "express";
import client from "./redisClient";
import { createClient } from "redis";

const subscriber = createClient({ url: "redis://localhost:6379" });
await subscriber.connect();
const router = Router();

router.post("/set", async (req, res) => {
  const { key, value } = req.body;
  await client.set(key, value);
  res.json({ stored: true, key, value });
});

router.get("/get/:key", async (req, res) => {
  const value = await client.get(req.params.key);
  res.json({ key: req.params.key, value });
});

router.post("/set-ttl", async (req, res) => {
  const { key, value, seconds } = req.body;
  await client.setEx(key, seconds, value);
  res.json({ stored: true, key, value, expiresIn: `${seconds}s` });
});

router.get("/ttl/:key", async (req, res) => {
  const ttl = await client.ttl(req.params.key);
  res.json({ key: req.params.key, ttlSeconds: ttl });
});

import db from "./db";

router.get("/user/:id", async (req, res) => {
  const { id } = req.params;
  const cacheKey = `user:${id}`;

  const cached = await client.get(cacheKey);
  if (cached) {
    return res.json({ source: "cache", data: JSON.parse(cached) });
  }

  // actual sqlite query
  const user = db.query("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "user not found" });

  await client.setEx(cacheKey, 30, JSON.stringify(user));

  res.json({ source: "db", data: user });
});

// store user as a hash
router.post("/user", async (req, res) => {
  const { id, name, email } = req.body;
  
  await client.hSet(`user:${id}`, { id, name, email });
  
  res.json({ stored: true });
});

// get user hash
router.get("/user-hash/:id", async (req, res) => {
    const { id } = req.params;
  const user = await client.hGetAll(`user:${id}`);
  
  if (!Object.keys(user).length) {
    return res.status(404).json({ error: "not found" });
  }
  
  res.json({ source: "redis", data: user });
});

// update just one field
router.patch("/user-hash/:id", async (req, res) => {
  const { field, value } = req.body;
  
  await client.hSet(`user:${req.params.id}`, { [field]: value });
  
  res.json({ updated: { [field]: value } });
});

// push a job to the queue
router.post("/job", async (req, res) => {
  const { type, payload } = req.body;

  const job = {
    id: crypto.randomUUID(),
    type,
    payload,
    createdAt: new Date().toISOString(),
  };

  await client.lPush("jobs:queue", JSON.stringify(job));

  res.json({ queued: true, job });
});

// see whats in the queue without removing
router.get("/jobs", async (req, res) => {
  const jobs = await client.lRange("jobs:queue", 0, -1);
  res.json({
    count: jobs.length,
    jobs: jobs.map(j => JSON.parse(j)),
  });
});

// pop one job manually
router.post("/job/pop", async (req, res) => {
  const raw = await client.rPop("jobs:queue");
  if (!raw) return res.json({ job: null, message: "queue is empty" });
  res.json({ job: JSON.parse(raw) });
});

// add or update a player's score
router.post("/leaderboard", async (req, res) => {
  const { player, score } = req.body;

  await client.zAdd("leaderboard", { score, value: player });

  const rank = await client.zRevRank("leaderboard", player);
  res.json({ player, score, rank: rank! + 1 });
});

// increment a player's score
router.post("/leaderboard/increment", async (req, res) => {
  const { player, by } = req.body;

  const newScore = await client.zIncrBy("leaderboard", by, player);
  const rank = await client.zRevRank("leaderboard", player);
  res.json({ player, newScore, rank: rank! + 1 });
});

// get top N players
router.get("/leaderboard/top/:n", async (req, res) => {
  const n = parseInt(req.params.n);
  const members = await client.zRangeWithScores("leaderboard", 0, n - 1, { REV: true });

  const leaderboard = members.map((m, i) => ({
    rank: i + 1,
    player: m.value,
    score: m.score,
  }));

  res.json(leaderboard);
});

// subscribe to a channel and listen
router.get("/subscribe/:channel", async (req, res) => {
  const { channel } = req.params;

  // SSE headers — keeps connection open
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  await subscriber.subscribe(channel, (message) => {
    res.write(`data: ${message}\n\n`);
  });

  // cleanup when client disconnects
  req.on("close", () => {
    subscriber.unsubscribe(channel);
  });
});

// publish a message
router.post("/publish", async (req, res) => {
  const { channel, message } = req.body;
  await client.publish(channel, message);
  res.json({ published: true, channel, message });
});

router.get("/limited", async (req, res) => {
  const key = `ratelimit:${req.ip}`;
  
  const count = await client.incr(key);
  
  if (count === 1) {
    // first request in this window — set expiry
    await client.expire(key, 10); // 10 second window
  }

  res.setHeader("X-RateLimit-Count", count);
  res.setHeader("X-RateLimit-Limit", 5);

  if (count > 5) {
    return res.status(429).json({ error: "too many requests", count });
  }

  res.json({ message: "allowed", count });
});

export default router;
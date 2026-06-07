import { createClient } from "redis";

const worker = createClient({ url: "redis://localhost:6379" });

async function start() {
  await worker.connect();
  console.log(" worker waiting for jobs...");

  while (true) {
    const result = await worker.brPop("jobs:queue", 0);
    if (!result) continue;

    const job = JSON.parse(result.element);
    console.log(" processing job:", job);

    await Bun.sleep(500);

    console.log(" done:", job.id);
  }
}


start();
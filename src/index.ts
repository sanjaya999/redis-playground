import express from "express";
import client from "./redisClient";
import router from "./route";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "hello from bun + express" });
});
app.use("/", router);

app.listen(3000, () => {
  console.log("server running at http://localhost:3000");
});
import { beforeAll, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Express } from "express";
import request from "supertest";

describe("Health Endpoint", () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  });

  it("should return status ok and unix timestamp", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("status", "ok");
    expect(response.body).toHaveProperty("timestamp");
    expect(typeof response.body.timestamp).toBe("number");

    // Verify timestamp is within last minute
    const now = Math.floor(Date.now() / 1000);
    expect(response.body.timestamp).toBeLessThanOrEqual(now);
    expect(response.body.timestamp).toBeGreaterThan(now - 60);
  });
});

import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { decodeFilename, resolveMimeType, titleFromFilename } from "../src/lib/files.js";
import { bearer } from "./helpers/fakeDb.js";

vi.mock("../src/lib/db.js", () => import("./helpers/fakeDb.js"));

describe("file helpers", () => {
  it("resolves supported types by extension", () => {
    expect(resolveMimeType("Policy.PDF")).toBe("application/pdf");
    expect(resolveMimeType("notes.md")).toBe("text/markdown");
    expect(resolveMimeType("readme.txt")).toBe("text/plain");
    expect(resolveMimeType("malware.exe")).toBeNull();
    expect(resolveMimeType("noextension")).toBeNull();
  });

  it("restores UTF-8 filenames that multer decoded as latin1", () => {
    const original = "политика_возврата.pdf";
    const mangled = Buffer.from(original, "utf8").toString("latin1");
    expect(decodeFilename(mangled)).toBe(original);
  });

  it("derives a readable title", () => {
    expect(titleFromFilename("refund_policy-2026.pdf")).toBe("refund policy 2026");
  });
});

describe("documents + ask http (no database)", () => {
  const app = createApp();
  const token = (role: "viewer" | "member") => bearer(role);

  it("viewers cannot upload", async () => {
    await request(app)
      .post("/api/v1/documents")
      .set("authorization", token("viewer"))
      .attach("file", Buffer.from("hi"), "a.txt")
      .expect(403);
  });

  it("rejects unsupported file types with 415", async () => {
    await request(app)
      .post("/api/v1/documents")
      .set("authorization", token("member"))
      .attach("file", Buffer.from("MZ"), "tool.exe")
      .expect(415);
  });

  it("requires a file", async () => {
    await request(app).post("/api/v1/documents").set("authorization", token("member")).expect(400);
  });

  it("validates ask input", async () => {
    await request(app).post("/api/v1/ask").set("authorization", token("viewer")).send({ question: "" }).expect(400);
  });
});

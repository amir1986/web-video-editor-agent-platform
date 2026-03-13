/**
 * Backend test suite — runs without external dependencies.
 * Tests: agents pipeline, knowledge base, tools, auth, API endpoints.
 *
 * Usage: node apps/api/src/test.js
 */

const assert = require("assert");
const crypto = require("crypto");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

(async () => {

// ---------------------------------------------------------------------------
// Knowledge Base Tests
// ---------------------------------------------------------------------------

console.log("\n--- Knowledge Base ---");

const { searchKnowledge, getEditingContext, KNOWLEDGE_BASE } = require("./ai/knowledge-base");

test("knowledge base has entries", () => {
  assert(KNOWLEDGE_BASE.length >= 15, `Expected >= 15 entries, got ${KNOWLEDGE_BASE.length}`);
});

test("searchKnowledge returns results for 'cut'", () => {
  const { results } = searchKnowledge("cut on action");
  assert(results.length > 0, "Expected results for 'cut on action'");
  assert(results[0].category === "cuts", `Expected category 'cuts', got '${results[0].category}'`);
});

test("searchKnowledge filters by category", () => {
  const { results } = searchKnowledge("duration pacing", "pacing");
  for (const r of results) {
    assert(r.category === "pacing", `Expected category 'pacing', got '${r.category}'`);
  }
});

test("searchKnowledge returns empty for nonsense", () => {
  const { results } = searchKnowledge("xyzzy12345");
  assert(results.length === 0, "Expected no results for nonsense query");
});

test("getEditingContext returns string", () => {
  const ctx = getEditingContext("cut selection", { duration: 60 });
  assert(typeof ctx === "string", "Expected string context");
  assert(ctx.includes("KNOWLEDGE BASE") || ctx === "", "Expected knowledge base header or empty");
});

// ---------------------------------------------------------------------------
// Agents Tests (deterministic agents only — no LLM needed)
// ---------------------------------------------------------------------------

console.log("\n--- Agents ---");

const { buildFallbackCutResult } = require("./ai/agents");

test("fallback: short video (<10s)", () => {
  const result = buildFallbackCutResult(8);
  assert(result.segments.length === 1, `Expected 1 segment, got ${result.segments.length}`);
  assert(result.segments[0].src_in === 0, "Expected src_in=0");
  assert(result.segments[0].src_out > 0 && result.segments[0].src_out <= 8, "Expected valid src_out");
});

test("fallback: medium video (10-30s)", () => {
  const result = buildFallbackCutResult(25);
  assert(result.segments.length === 2, `Expected 2 segments, got ${result.segments.length}`);
});

test("fallback: long video (>30s)", () => {
  const result = buildFallbackCutResult(120);
  assert(result.segments.length === 4, `Expected 4 segments, got ${result.segments.length}`);
  // Segments should be sorted and non-overlapping
  for (let i = 1; i < result.segments.length; i++) {
    assert(result.segments[i].src_in >= result.segments[i - 1].src_out,
      `Segment ${i} overlaps with ${i - 1}`);
  }
});

test("fallback: segments are within bounds", () => {
  const dur = 60;
  const result = buildFallbackCutResult(dur);
  for (const seg of result.segments) {
    assert(seg.src_in >= 0, `src_in ${seg.src_in} is negative`);
    assert(seg.src_out <= dur, `src_out ${seg.src_out} exceeds duration ${dur}`);
    assert(seg.src_out > seg.src_in, `src_out ${seg.src_out} <= src_in ${seg.src_in}`);
  }
});

// ---------------------------------------------------------------------------
// Tools Tests (calculate_pacing — no ffmpeg needed)
// ---------------------------------------------------------------------------

console.log("\n--- Tools ---");

const { TOOL_DEFINITIONS, TOOL_HANDLERS } = require("./ai/tools");

test("tool definitions are valid", () => {
  assert(TOOL_DEFINITIONS.length >= 5, `Expected >= 5 tools, got ${TOOL_DEFINITIONS.length}`);
  for (const tool of TOOL_DEFINITIONS) {
    assert(tool.name, "Tool must have a name");
    assert(tool.description, "Tool must have a description");
    assert(tool.input_schema, "Tool must have input_schema");
  }
});

test("all tool definitions have handlers", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert(typeof TOOL_HANDLERS[tool.name] === "function",
      `Handler missing for tool '${tool.name}'`);
  }
});

await testAsync("calculate_pacing returns valid result", async () => {
  const result = await TOOL_HANDLERS.calculate_pacing({
    total_duration: 120,
    content_type: "action",
    target_platform: "youtube",
  });
  assert(result.content_type === "action");
  assert(result.target_platform === "youtube");
  assert(result.total_duration === 120);
  assert(result.recommended.highlight_duration.length === 2);
  assert(result.recommended.segment_count.length === 2);
});

await testAsync("search_knowledge tool handler works", async () => {
  const result = await TOOL_HANDLERS.search_knowledge({
    query: "hard cut transition",
    category: "transitions",
  });
  assert(result.results.length > 0, "Expected results");
  assert(result.query === "hard cut transition");
});

// ---------------------------------------------------------------------------
// Auth Tests
// ---------------------------------------------------------------------------

console.log("\n--- Auth ---");

// Test token generation and verification
// We simulate the auth functions since they're inside index.js
const AUTH_SECRET_TEST = "test_secret_123";

function generateTokenTest(userId) {
  const payload = JSON.stringify({ uid: userId, iat: Date.now() });
  const hmac = crypto.createHmac("sha256", AUTH_SECRET_TEST).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64url") + "." + hmac;
}

function verifyTokenTest(token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expected = crypto.createHmac("sha256", AUTH_SECRET_TEST).update(payload).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(payload);
    if (Date.now() - data.iat > 86400000) return null;
    return data;
  } catch { return null; }
}

test("token generation produces valid format", () => {
  const token = generateTokenTest("user_123");
  assert(token.includes("."), "Token should contain a dot separator");
  const parts = token.split(".");
  assert(parts.length === 2, "Token should have 2 parts");
});

test("token verification succeeds for valid token", () => {
  const token = generateTokenTest("user_456");
  const user = verifyTokenTest(token);
  assert(user !== null, "Valid token should verify");
  assert(user.uid === "user_456", `Expected uid 'user_456', got '${user.uid}'`);
});

test("token verification fails for tampered token", () => {
  const token = generateTokenTest("user_789");
  const tampered = token.slice(0, -4) + "xxxx";
  const user = verifyTokenTest(tampered);
  assert(user === null, "Tampered token should not verify");
});

test("token verification fails for null/empty", () => {
  assert(verifyTokenTest(null) === null);
  assert(verifyTokenTest("") === null);
  assert(verifyTokenTest("no-dot") === null);
});

// ---------------------------------------------------------------------------
// MCP Server Tests
// ---------------------------------------------------------------------------

console.log("\n--- MCP Server ---");

const { MCPServer, SERVER_INFO } = require("./mcp-server");

await testAsync("MCP initialize", async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
    id: 1,
  });
  assert(res.result.serverInfo.name === SERVER_INFO.name);
  assert(res.result.capabilities.tools !== undefined);
});

await testAsync("MCP tools/list", async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({ method: "tools/list", id: 2 });
  assert(res.result.tools.length >= 5, `Expected >= 5 tools, got ${res.result.tools.length}`);
  for (const tool of res.result.tools) {
    assert(tool.inputSchema, `Tool '${tool.name}' missing inputSchema`);
  }
});

await testAsync("MCP resources/list", async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({ method: "resources/list", id: 3 });
  assert(res.result.resources.length >= 1, "Expected at least 1 resource");
});

await testAsync("MCP resources/read", async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({
    method: "resources/read",
    params: { uri: "knowledge://video-editing/all" },
    id: 4,
  });
  assert(res.result.contents.length === 1);
  assert(res.result.contents[0].text.length > 100, "Knowledge base content should be substantial");
});

await testAsync("MCP unknown method returns error", async () => {
  const server = new MCPServer();
  const res = await server.handleRequest({ method: "unknown/method", id: 5 });
  assert(res.error, "Expected error for unknown method");
  assert(res.error.code === -32601);
});

// ---------------------------------------------------------------------------
// LLM Client Tests (retry logic, no actual API calls)
// ---------------------------------------------------------------------------

console.log("\n--- LLM Client ---");

const { withRetry } = require("./ai/llm-client");

await testAsync("withRetry succeeds on first try", async () => {
  let attempts = 0;
  const result = await withRetry(async () => { attempts++; return "ok"; }, { maxRetries: 3 });
  assert(result === "ok");
  assert(attempts === 1, `Expected 1 attempt, got ${attempts}`);
});

await testAsync("withRetry retries on failure", async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("transient");
    return "recovered";
  }, { maxRetries: 3, baseDelay: 10 });
  assert(result === "recovered");
  assert(attempts === 3, `Expected 3 attempts, got ${attempts}`);
});

await testAsync("withRetry throws after max retries", async () => {
  try {
    await withRetry(async () => { throw new Error("permanent"); }, { maxRetries: 1, baseDelay: 10 });
    assert(false, "Should have thrown");
  } catch (err) {
    assert(err.message === "permanent");
  }
});

// ---------------------------------------------------------------------------
// EditPlan Pipeline Integration Test
// ---------------------------------------------------------------------------

console.log("\n--- Pipeline Integration ---");

const { runEditPipeline } = require("./ai/agents");

await testAsync("runEditPipeline returns valid plan (fallback mode)", async () => {
  const videoMeta = { duration: 60, fps: 30, width: 1920, height: 1080 };
  const plan = await runEditPipeline(videoMeta, []);
  assert(plan.segments, "Plan should have segments");
  assert(plan.segments.length > 0, "Plan should have at least 1 segment");
  assert(plan.transitions, "Plan should have transitions");
  assert(plan.render_constraints, "Plan should have render_constraints");
  assert(plan.quality_guard, "Plan should have quality_guard");
  assert(plan.quality_guard.constraints_ok === true, "Quality guard should pass");

  // Segments should be valid
  for (const seg of plan.segments) {
    assert(seg.src_in >= 0, `src_in ${seg.src_in} should be >= 0`);
    assert(seg.src_out <= 60, `src_out ${seg.src_out} should be <= 60`);
    assert(seg.src_out > seg.src_in, `src_out should be > src_in`);
  }

  // Render constraints should match source
  assert(plan.render_constraints.target_width === 1920);
  assert(plan.render_constraints.target_height === 1080);
});

await testAsync("runEditPipeline accepts styleContext option", async () => {
  const videoMeta = { duration: 60, fps: 30, width: 1920, height: 1080 };
  const styleContext = "--- TEST STYLE ---\nPrefer fast cuts, 3-5 segments.\n--- END ---";
  const plan = await runEditPipeline(videoMeta, [], null, { styleContext });
  assert(plan.segments, "Plan should have segments with styleContext");
  assert(plan.segments.length > 0, "Plan should have at least 1 segment");
  assert(plan.quality_guard.constraints_ok === true, "Quality guard should pass");
});

// ---------------------------------------------------------------------------
// Style Store Tests
// ---------------------------------------------------------------------------

console.log("\n--- Style Store ---");

const { getOrCreateProfile, updateFingerprint, deleteProfile, loadProfile, FINGERPRINT_THRESHOLD } = require("./ai/style-store");

const TEST_USER = "__test_user_" + Date.now();

test("getOrCreateProfile creates new profile", () => {
  const profile = getOrCreateProfile(TEST_USER);
  assert(profile.userId === TEST_USER, `Expected userId=${TEST_USER}`);
  assert(profile.projectCount === 0, "Expected projectCount=0");
  assert(profile.fingerprint === null, "Expected null fingerprint");
  assert(Array.isArray(profile.history), "Expected history array");
});

test("updateFingerprint increments count", () => {
  const fp = { cutRhythm: "fast", avgSegmentDuration: 3.5 };
  const profile = updateFingerprint(TEST_USER, fp, { segments: 4 });
  assert(profile.projectCount === 1, `Expected projectCount=1, got ${profile.projectCount}`);
  assert(profile.fingerprint.cutRhythm === "fast", "Expected fingerprint data");
  assert(profile.history.length === 1, "Expected 1 history entry");
});

test("updateFingerprint accumulates", () => {
  const fp2 = { cutRhythm: "medium", avgSegmentDuration: 5.0 };
  const profile = updateFingerprint(TEST_USER, fp2, { segments: 3 });
  assert(profile.projectCount === 2, `Expected projectCount=2, got ${profile.projectCount}`);
  assert(profile.fingerprint.cutRhythm === "medium", "Expected updated fingerprint");
  assert(profile.history.length === 2, "Expected 2 history entries");
});

test("loadProfile returns saved data", () => {
  const profile = loadProfile(TEST_USER);
  assert(profile !== null, "Expected profile to exist");
  assert(profile.projectCount === 2, "Expected projectCount=2");
});

test("deleteProfile removes data", () => {
  deleteProfile(TEST_USER);
  const profile = loadProfile(TEST_USER);
  assert(profile === null, "Expected profile to be null after delete");
});

test("FINGERPRINT_THRESHOLD is 4", () => {
  assert(FINGERPRINT_THRESHOLD === 4, `Expected threshold=4, got ${FINGERPRINT_THRESHOLD}`);
});

// ---------------------------------------------------------------------------
// Style Resolver Tests
// ---------------------------------------------------------------------------

console.log("\n--- Style Resolver ---");

const { resolveStyle } = require("./ai/style-resolver");

test("resolveStyle returns discovery for null userId", () => {
  const result = resolveStyle(null);
  assert(result.mode === "discovery", "Expected discovery mode");
  assert(result.styleContext === null, "Expected null styleContext");
  assert(result.profile === null, "Expected null profile");
});

test("resolveStyle returns discovery for new user", () => {
  const result = resolveStyle("__test_new_user_" + Date.now());
  assert(result.mode === "discovery", "Expected discovery mode for new user");
  assert(result.styleContext === null, "Expected null styleContext for new user");
  assert(result.profile !== null, "Expected profile to be created");
  // Cleanup
  deleteProfile(result.profile.userId);
});

test("resolveStyle returns guided when threshold met", () => {
  const uid = "__test_guided_" + Date.now();
  const fp = { testStyle: true };
  for (let i = 0; i < FINGERPRINT_THRESHOLD; i++) {
    updateFingerprint(uid, fp, { test: true });
  }
  const result = resolveStyle(uid);
  assert(result.mode === "guided", `Expected guided mode, got ${result.mode}`);
  assert(result.styleContext !== null, "Expected styleContext string");
  assert(result.styleContext.includes("STYLE FINGERPRINT"), "Expected fingerprint header in context");
  // Cleanup
  deleteProfile(uid);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
})();

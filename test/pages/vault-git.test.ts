import { expect, test } from "vitest";
import { parseGitLog, gitCommitTimes, parseFileHistory, vaultFileHistory } from "../../src/pages/vault-git.js";

// Shape of `git log --relative --format=@@%cI --name-status -M`: a marker line
// per commit (newest first) followed by tab-separated status/path lines.
const SAMPLE = [
  "@@2026-07-27T13:05:36+00:00",
  "",
  "M\twiki/concepts/gbrain-knowledge-brain.md",
  "A\traw/2026-07-27-session.md",
  "",
  "@@2026-07-26T20:31:01+00:00",
  "",
  "M\twiki/concepts/gbrain-knowledge-brain.md", // older commit — must NOT overwrite
  "A\traw/2026-07-26-session.md",
  "",
].join("\n");

test("parseGitLog maps each path to its most-recent commit (first occurrence wins)", () => {
  const m = parseGitLog(SAMPLE);
  expect(m.get("wiki/concepts/gbrain-knowledge-brain.md")).toBe("2026-07-27T13:05:36+00:00");
  expect(m.get("raw/2026-07-27-session.md")).toBe("2026-07-27T13:05:36+00:00");
  expect(m.get("raw/2026-07-26-session.md")).toBe("2026-07-26T20:31:01+00:00");
  expect(m.size).toBe(3);
});

// The reorganization bug: moving a file into a new directory is not an edit, so
// it must not make the page look freshly authored. The time has to come from the
// last commit that actually changed the bytes, under whichever name it had then.
test("parseGitLog ignores a pure rename and keeps the pre-rename content time", () => {
  const m = parseGitLog(
    [
      "@@2026-08-14T08:40:03+00:00",
      "",
      "R100\twiki/entities/health-records.md\twiki/entities/private/health-records.md",
      "",
      "@@2026-03-02T10:00:00+00:00",
      "",
      "M\twiki/entities/health-records.md",
      "",
    ].join("\n"),
  );
  expect(m.get("wiki/entities/private/health-records.md")).toBe("2026-03-02T10:00:00+00:00");
  // The old path is history; only the current path is stampable.
  expect(m.has("wiki/entities/health-records.md")).toBe(false);
  expect(m.size).toBe(1);
});

test("parseGitLog treats a rename that also edited the file as a change event", () => {
  const m = parseGitLog(
    [
      "@@2026-08-15T22:44:16+00:00",
      "",
      "R071\tetc/jobs.mem\twiki/concepts/jobs-mem-persona.md",
      "",
      "@@2026-01-01T00:00:00+00:00",
      "",
      "M\tetc/jobs.mem",
      "",
    ].join("\n"),
  );
  expect(m.get("wiki/concepts/jobs-mem-persona.md")).toBe("2026-08-15T22:44:16+00:00");
});

test("parseGitLog follows a chain of renames back to the current path", () => {
  const m = parseGitLog(
    [
      "@@2026-08-01T00:00:00+00:00",
      "",
      "R100\twiki/concepts/b.md\twiki/concepts/c.md",
      "",
      "@@2026-07-01T00:00:00+00:00",
      "",
      "R100\twiki/concepts/a.md\twiki/concepts/b.md",
      "",
      "@@2026-02-01T00:00:00+00:00",
      "",
      "A\twiki/concepts/a.md",
      "",
    ].join("\n"),
  );
  expect(m.get("wiki/concepts/c.md")).toBe("2026-02-01T00:00:00+00:00");
  expect(m.size).toBe(1);
});

// A later edit under the new name still wins over the pre-rename history.
test("parseGitLog prefers a post-rename edit over the pre-rename content time", () => {
  const m = parseGitLog(
    [
      "@@2026-08-20T00:00:00+00:00",
      "",
      "M\twiki/concepts/new.md",
      "",
      "@@2026-08-10T00:00:00+00:00",
      "",
      "R100\twiki/concepts/old.md\twiki/concepts/new.md",
      "",
      "@@2026-01-01T00:00:00+00:00",
      "",
      "M\twiki/concepts/old.md",
      "",
    ].join("\n"),
  );
  expect(m.get("wiki/concepts/new.md")).toBe("2026-08-20T00:00:00+00:00");
});

test("gitCommitTimes returns an empty map when the runner throws (no repo / no git)", () => {
  const m = gitCommitTimes("/nowhere", () => { throw new Error("not a git repository"); });
  expect(m.size).toBe(0);
});

test("gitCommitTimes parses the injected runner output", () => {
  const m = gitCommitTimes("/whatever", () => SAMPLE);
  expect(m.get("raw/2026-07-27-session.md")).toBe("2026-07-27T13:05:36+00:00");
});

// --- full history ---------------------------------------------------------

// Same log, one field wider: `--format=@@%cI%x09%s` puts the subject on the
// marker line. parseGitLog ignores it, which is what keeps the samples above
// valid against the new format.
const SAMPLE_WITH_SUBJECTS = [
  "@@2026-07-27T13:05:36+00:00\twiki: the newer one",
  "",
  "M\twiki/concepts/gbrain-knowledge-brain.md",
  "",
  "@@2026-07-26T20:31:01+00:00\twiki: the older one",
  "",
  "M\twiki/concepts/gbrain-knowledge-brain.md",
  "",
].join("\n");

test("parseGitLog still maps times when the marker line carries a subject", () => {
  const m = parseGitLog(SAMPLE_WITH_SUBJECTS);
  expect(m.get("wiki/concepts/gbrain-knowledge-brain.md")).toBe("2026-07-27T13:05:36+00:00");
});

test("parseFileHistory keeps every commit that changed a path, newest first", () => {
  const h = parseFileHistory(SAMPLE_WITH_SUBJECTS);
  expect(h.get("wiki/concepts/gbrain-knowledge-brain.md")).toEqual([
    { iso: "2026-07-27T13:05:36+00:00", subject: "wiki: the newer one" },
    { iso: "2026-07-26T20:31:01+00:00", subject: "wiki: the older one" },
  ]);
});

// The two readers share one rename model on purpose. If they did not, a page's
// "last changed" date and its own commit list could disagree about whether a
// move was an edit — the exact shape of drift section 5.5 of the whitepaper
// documents for the orphan predicate.
test("parseFileHistory attributes pre-rename commits forward and drops the pure rename", () => {
  const h = parseFileHistory(
    [
      "@@2026-08-14T08:40:03+00:00\tchore: move it",
      "",
      "R100\twiki/entities/a.md\twiki/entities/private/a.md",
      "",
      "@@2026-03-02T10:00:00+00:00\twiki: write it",
      "",
      "A\twiki/entities/a.md",
      "",
    ].join("\n"),
  );
  expect(h.get("wiki/entities/private/a.md")).toEqual([
    { iso: "2026-03-02T10:00:00+00:00", subject: "wiki: write it" },
  ]);
  expect(h.has("wiki/entities/a.md")).toBe(false);
});

test("parseFileHistory counts a rename that also edited the file", () => {
  const h = parseFileHistory(
    [
      "@@2026-08-15T22:44:16+00:00\twiki: rewrite and move",
      "",
      "R071\tetc/jobs.mem\twiki/concepts/jobs-mem-persona.md",
      "",
    ].join("\n"),
  );
  expect(h.get("wiki/concepts/jobs-mem-persona.md")).toHaveLength(1);
});

test("vaultFileHistory returns an empty map when the runner throws", () => {
  expect(vaultFileHistory("/nowhere", () => { throw new Error("not a git repository"); }).size).toBe(0);
});

---
name: phase-process
description: 'MeshLite phase execution process. Use when starting a new phase, writing an approach, generating a runbook, writing implementation code, running tests, producing an outcome report, or discussing results. Defines the 6-stage workflow: Approach → Runbook → Coding → Execution → Report → Discussion.'
argument-hint: 'phase number or stage name (e.g. "phase-2" or "approach")'
---

# MeshLite — Phase Execution Process

This skill defines how every phase of the MeshLite project is executed.
Follow this process in order for every phase. Do not skip steps.

---

## The Six-Stage Process

```
Stage 1: APPROACH    → Define what is being built and why
Stage 2: RUNBOOK     → Write the step-by-step implementation and test guide
Stage 3: CODING      → Implement each task from the runbook; commit when each task passes its unit tests
Stage 4: EXECUTION   → Deploy, run integration tests, follow runbook test sections in order
Stage 5: REPORT      → Record results, issues, decisions, readiness verdict
Stage 6: DISCUSSION  → Confirm understanding; accept risk items; commit phase to main
```

---

## Stage 1 — Approach

**Output:** `docs/phase-N/phase-N-approach.md`

### Must answer before proceeding:
1. **Goal** — Single sentence: what does this phase prove or disprove?
2. **Scope** — What is built? What is explicitly NOT in scope?
3. **Components** — What new code, config, or infrastructure is added?
4. **Dependencies** — What must already be working from the previous phase?
5. **Exit criteria** — Specific, measurable, testable pass/fail conditions.
6. **Risk items** — Known unknowns; what could go wrong?

### Rules:
- Exit criteria must be testable pass/fail statements — not vague goals.
- Scope must explicitly list what is NOT being done this phase.
- Do not start the runbook until the approach is reviewed and agreed.

---

## Stage 2 — Runbook

**Output:** `docs/phase-N/phase-N-runbook.md`

### Required sections in every runbook:

```
1. Prerequisites
   - Host machine requirements
   - Required tools and exact versions
   - What must already be running from previous phases

2. One-Time Machine Setup
   - New tools to install
   - New config required

3. Steps (numbered)
   - One outcome per step
   - States which terminal environment it runs in (WSL2 / kind node / PowerShell)
   - Shows expected output
   - Shows what to do if expected output is not seen

4. Tests (one section per exit criterion from Approach)
   - Maps to exactly one exit criterion
   - Exact commands to run
   - Exact expected output
   - Pass/fail condition stated explicitly

5. Exit Criteria Checklist
   - One checkbox per criterion
   - Each checkbox links to the test that verifies it

6. Teardown
   - How to cleanly remove everything this phase created

7. Troubleshooting
   - One entry per known failure mode
   - Format: symptom → root cause → resolution
```

### Rules:
- Every command must name its terminal environment as a comment.
- Never assume a tool is available — verify it or install it explicitly.
- Verify all file paths against the actual workspace before writing them.
- Add a troubleshooting entry for every error encountered. Keep it updated.

---

## Stage 3 — Coding

**What to do:** Implement each task listed in the runbook, in the order they appear.

### Rules during coding:
1. Implement one task at a time. Do not start the next task until the current one compiles and its unit tests pass.
2. Follow the interfaces defined in the protobuf / shared contracts exactly. Do not deviate — downstream phases depend on them.
3. Write unit tests alongside the code, not after. Exit criteria that require coverage targets must be met before moving on.
4. Do not add features, abstractions, or error handling beyond what the runbook task describes.
5. When a task reveals a problem with the runbook (wrong interface, missing dependency, wrong path), update the runbook before continuing.
6. Commit after each task passes. Commit message: `phase-N: task N.X — <component name>`.

### Definition of "task complete":
- Code compiles with no errors or warnings.
- Unit tests for this task pass.
- No placeholder `todo!()` / `unimplemented!()` left in paths that will be called during Stage 4.

---

## Stage 4 — Execution

**What to do:** Follow the runbook exactly.

### Rules during execution:
1. Run steps in order. Each step's output feeds the next.
2. If a step fails, diagnose before continuing. Do not proceed with broken state.
3. Update the runbook in real time when commands need changing or errors are new.
4. Record actual output for every test. Do not rely on memory for the report.
5. Do not modify code to make a test pass without understanding why it failed.

### Terminal discipline:

| Terminal | Prompt | Used for |
|---|---|---|
| WSL2 | `user@host:~$` | `kubectl`, `docker`, cargo builds, kind |
| Kind node | `root@meshlite-dev-worker:#` | eBPF loader, binaries running inside the node |
| PowerShell | `PS C:\>` | WSL2 management, Docker Desktop only |

- Never run `kubectl` from inside the kind node.
- Never run node binaries from WSL2.

---

## Stage 5 — Report

**Output:** `docs/phase-N/phase-N-outcome-report.md`

### Required sections:

| Section | Contents |
|---|---|
| Header | Date, OS, kernel, cluster version, stack versions |
| Executive Summary | Pass/fail verdict in one paragraph |
| What Was Built | Table: component, description, file location |
| Concepts Verified | One subsection per concept; what was proven and why it matters |
| Test Results | Table: test ID, criterion, result (✅/❌), measured value |
| Issues Encountered | Table: issue, root cause, resolution — every issue that was hit |
| Architecture Decisions | Numbered; decisions made this phase that are now locked in |
| Next Phase Readiness | Verdict, what next phase needs, what it adds, risk items |

### Rules:
- Test results must show actual measured values, not just pass/fail.
- Issues section must be complete — if it happened, it goes in the table.
- Architecture decisions must be stated as decisions, not observations.

---

## Stage 6 — Discussion

**What to do:** Review the report together before starting the next phase.

### Questions to answer:
1. Does everyone understand what was proven and why it matters?
2. Is anything in the report unclear or incomplete?
3. Are all exit criteria genuinely satisfied, or did any pass on a technicality?
4. Are the risk items for the next phase understood and accepted?
5. Is there any deferred work that needs to be tracked?

### Rules:
- Do not start Stage 1 of the next phase until discussion confirms current phase is closed.
- Questions that cannot be answered immediately become risk items in the next Approach.
- **Do not commit until the user explicitly declares the phase done.** Wait for all queries to be resolved first.

### Final Commit (triggered by user declaring phase done):

Once the user confirms the phase is closed with no outstanding questions, commit everything to `main`:

```sh
# PowerShell — run from workspace root
git add -A
git commit -m "phase-N: close — <one-line summary of what was proven>"
git push origin main
```

Commit message rules:
- Prefix: `phase-N: close —` (replace N with the actual phase number)
- Summary: one sentence describing what the phase proved or delivered (not a list of files)
- Example: `phase-3: close — mTLS cert distribution and policy enforcement verified end-to-end`

---

## Per-Phase Document Checklist

Before closing any phase, all three documents must exist plus all tasks coded, tested, and committed:

```
docs/phase-N/
├── phase-N-approach.md        ← written before any code
├── phase-N-runbook.md         ← written before coding, updated live
└── phase-N-outcome-report.md  ← written after all tests pass

Code:
  All runbook tasks implemented
  All unit tests passing
  All integration tests (Stage 4) passing

Git:
  User has declared phase done (all queries resolved)
  All changes committed to main: "phase-N: close — <summary>"
  Commit pushed to origin
```

---

## Phase 1 & 2 Retrospective — Problems This Process Prevents

Every row below is a real error hit during Phase 1 live execution:

| Problem | Stage + Rule That Prevents It |
|---|---|
| Wrong binary paths in runbook (`kprobe-ebpf/target/` vs `kprobe/target/`) | Stage 2: verify all paths against actual workspace before writing |
| `linux-headers`, `bpf-linker`, `kind` missing from setup | Stage 2: never assume a tool is available — verify or install explicitly |
| Both pods scheduled on same node — no intercept output appeared | Stage 2: verify test environment assumptions in prerequisites |
| `curl`/`wget` not available in test pod image | Stage 2: verify every command is available in the target environment |
| `kubectl` run from inside kind node (no kubeconfig) | Stage 2 & 3: every command must state which terminal it runs in |
| ClusterIP accessed from WSL2 host (not routable) | Stage 2 & 3: every command must state which terminal it runs in |
| No baseline performance recorded before first test | Stage 3: record actual output for every test during execution |
| Troubleshooting section empty until errors were hit live | Stage 3: add troubleshooting entry for every error as it occurs |
| Anti-affinity rules caused rolling update deadlock | Stage 2: verify fixture config handles rollouts, not just initial deploy |

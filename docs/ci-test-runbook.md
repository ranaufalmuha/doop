# CI test runbook

What to do when a `test` job fails or hangs. The pipeline is
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml); this page is the
3am version.

## How the tests are split

| Check                   | Runs                                                                                      | Normal wall clock  |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------------------ |
| `test (1)` … `test (4)` | the `parallel` + `clipboard` projects (`--project parallel --project clipboard`), sharded | ~2-3 min per shard |
| `test-drawing`          | the `drawing` project alone: `tests/drawingBrowser.test.ts`, no file parallelism          | ~2-4 min           |
| `tests`                 | aggregator: green only when all five jobs above are green                                 | seconds            |

`drawingBrowser` is 98 tests that each reload the whole Stage fixture, so it
gets a runner to itself. The split lives in `vite.config.ts` as three projects
(`parallel`, `clipboard`, `drawing`), not in a `--exclude` flag: an inline
project's `exclude` overrides the CLI one, so an exclude flag silently leaves
the file in every shard. The shard jobs select `parallel` + `clipboard`; the
dedicated job selects `drawing`.

Sharing a 2-vCPU runner with the other Chromium files is what produced the
11-minute job and the `Hook timed out in 30000ms` cascade in
[run 42595435659](https://github.com/ranaufalmuha/doop/actions/runs/42595435659) (see also PR history
`fix(test): root out the flaky browser tests in CI (#394)` and
`fix(canvas): root out the two browser tests that flake on CI (#433)`).

Both kinds of test job have `timeout-minutes: 15`, so a wedged browser fails
the run instead of sitting there until a newer push cancels it.

If a `test (N)` log ever shows `tests/drawingBrowser.test.ts (98 tests)`, the
project config regressed: the file must only appear in `test-drawing`.

## Symptom: the run sits in `test-drawing` with no new output

A healthy job prints test files as they finish and ends inside ~4 minutes.

1. Open the failing job: **Actions → CI → the run → `test-drawing`**. The run id
   is in the URL (`/actions/runs/<run-id>`) and the job id is in the job URL
   (`/job/<job-id>`).
2. Read the last output lines. If the log ends in
   `beforeEach/<step> failed after Nms: …`, the named step
   (`load the fixture`, `wait for the harness`, `seed the canvas`, …) is the
   slow one. `tests/drawingBrowser.test.ts` logs this for exactly this reason.
3. If the log ends in `Hook timed out in 90000ms` with no step name, the
   renderer never answered at all. That is the hang: capture the run and job
   ids, cancel (next section), and treat it as a bug — do **not** rerun first.

### Cancel

Cancelling a job means cancelling its run (GitHub has no per-job cancel API):

```sh
gh run cancel <run-id>            # or: Actions UI → the run → "Cancel workflow"
```

Cancelling the _run_ cancels every job in it, including the other shards. That
is acceptable here: the failed run is already red, and the fix will produce a
fresh run.

### Collecting the logs

```sh
gh run view <run-id> --log                                    # whole run
curl -sL -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/ranaufalmuha/doop/actions/jobs/<job-id>/logs" \
  > /tmp/job.log                                              # one job
gh api repos/ranaufalmuha/doop/actions/jobs/<job-id> \
  --jq '{conclusion,started_at,completed_at,runner_name}'
```

`started_at`/`completed_at` tell a slow job from a hung one; a very short job
that never ran tests is usually a runner or setup failure, not a flake.

## Symptom: `Hook timed out in 90000ms` or a step name after a long duration

The hook budget is 90s because the inner waits can legitimately take 30s each
on a cold runner (`NAVIGATION_TIMEOUT_MS` and the harness wait). The hook
budget is _above_ their sum so the inner wait reports first. If you see the
hook timeout itself, the page stopped answering: note the test name from the
failure block, the run/job ids, and open a CI stability issue with the log
excerpt.

## Re-running: recorded, never silent

`--retry=0` is explicit in both jobs and the pipeline has no retry action.
Vitest will not retry a failed test, and a rerun is a deliberate act:

1. Record the failed **run id**, **job id**, head SHA, and the failing step or
   test in the PR or issue _before_ rerunning.
2. Rerun only the failed job:
   ```sh
   gh run rerun <run-id> --job <job-id>      # one job
   gh run rerun <run-id>                     # whole run
   ```
3. When it goes green, say so explicitly in the same comment — "green on a
   rerun of job `<job-id>`" — so the gate is honest. A green rerun does not
   erase the failed attempt; both ids stay in the record.
4. Two failures of the same job on identical code is a regression or a flake,
   not bad luck. Open a CI stability issue with both run ids.

## Quarantine (last resort, always with an expiry)

Only when a test has failed twice on identical code and a fix is not ready:

- Skip the narrowest thing that flakes — one `it` or a `describe` block, never
  the whole file.
- Make the skip tracked in the source:
  ```ts
  // QUARANTINE 2026-11-23 (ANT-1234): hookTimeout on a cold runner; see run <run-id>.
  it.skip('…', …)
  ```
- Open the tracking issue and put its id and the expiry date in the comment.
  The expiry is at most two weeks out; on expiry the test is un-skipped or the
  issue is re-decided. A quarantine without a date is a deleted test.

## Verifying a CI change

The workflow has `workflow_dispatch`, so a branch can be exercised without an
empty commit:

```sh
gh workflow run ci.yml --ref <branch>
gh run list --branch <branch> --workflow ci.yml --limit 5
```

For this fix the bar is five consecutive **non-retried** green runs of
`test-drawing` (and the shard jobs) on the branch, then five more green runs
on `paperclip` before the issue is closed.

## Rollback

The workflow and the test change are one commit. Revert it:

```sh
git revert <merge-sha>        # on a pc/doop-* branch, PR to paperclip
```

Reverting restores `drawingBrowser` to the shard matrix and the 30s hook
budget; no data or infrastructure is touched, so no other rollback step is
needed.

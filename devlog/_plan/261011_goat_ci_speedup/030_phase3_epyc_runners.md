# 030 wp3: EPYC goat runners and CI proof

## Runner provisioning (needs sudo; decision `epyc-sudo`)

Host: neuralarcade@192.168.0.8 via `ssh -J dlt-studio` from juns-macbook-pro. Existing pattern
(observed): /opt/actions-runner/goat-epyc-0{1,2}, owner ghrunner, unit
`actions.runner.goat-si-goat.<name>.service` (User=ghrunner, runsvc.sh), `.env` =
`HOME=/opt/actions-runner/<name>/_home\nLANG=C.UTF-8\n`, labels self-hosted,Linux,X64,goat,epyc.
Workflow asserts `$HOME = /opt/actions-runner/$RUNNER_NAME/_home` (goat-ci.yml Toolchain step).

NEW (outside repo) `~neuralarcade/goat-runner-setup/add-goat-runners.sh` (staged, sha256
b2dd7522...4d0cb7, source /tmp/goat-ci/epyc/add-goat-runners.sh). States per runner, checked before
any token is required: active -> skip; configured (`.runner` exists) but unit missing -> `svc.sh install`
then enable/start; unit installed but inactive -> `systemctl enable --now`; unconfigured -> extract
tarball (unless already extracted), `config.sh --unattended --labels goat,epyc --work _work --replace`,
then the above. `.env` is rewritten each time. The token file is deleted by an EXIT trap on
success or failure; a rerun with every runner already configured needs no token.

Token handoff (agent, right before the user's command; token never in argv or chat):

```sh
gh api -X POST repos/goat-si/goat/actions/runners/registration-token --jq .token \
  | ssh juns-macbook-pro "ssh -J dlt-studio neuralarcade@192.168.0.8 'umask 077; cat > ~/goat-runner-setup/token'"
```

Then the user runs (sudo prompts on the tty):

```sh
ssh -t juns-macbook-pro "ssh -t -J dlt-studio neuralarcade@192.168.0.8 'sudo bash ~/goat-runner-setup/add-goat-runners.sh goat-epyc-03 goat-epyc-04 goat-epyc-05 goat-epyc-06'"
```

Verify: `gh api repos/goat-si/goat/actions/runners` lists the new names online with labels goat,epyc;
`systemctl is-active` per unit.

## CI proof (decision `push`)

With approval: `git push -u origin codex/ci-speedup`, then `gh workflow run goat-ci.yml --ref codex/ci-speedup`,
then job timings via `gh api repos/goat-si/goat/actions/runs/<id>/jobs` (created/started/completed,
runner_name) and Test-step duration. Compare against run 38134302415 (goat-test 22.6 min, Test step 21.5 min).
During the goat-test job, sample on EPYC once a minute (read-only, as neuralarcade): count of
ghrunner processes, `ls /proc/<worker pid>/fd | wc -l` for vitest workers, load average, and the
vitest worker count (number of node processes whose parent is the vitest main process). Record in
/tmp/goat-ci/epyc-load.txt. Check the log for port-bind errors (`EADDRINUSE`) and rerun the job once
(`gh run rerun --job`) to observe flake behavior; both runs' pass counts go in the D summary.
Without approval: NEEDS_HUMAN; local timings stand as evidence.

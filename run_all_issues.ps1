$Owner = "amir1986"
$RepoFull = "$Owner/web-video-editor-agent-platform"
$GhToken = (gh auth token).Trim()
$IssueLines = Get-Content ".\issues\created_issues.txt"
$WslRepo = "/mnt/c/WINDOWS/system32/web-video-editor-agent-platform-clean"

$Issues = @(
    @{ Branch="sweagent/issue-3";  Url=(($IssueLines | Where-Object { $_ -like "issue2=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #3 - import video + preview player" },
    @{ Branch="sweagent/issue-4";  Url=(($IssueLines | Where-Object { $_ -like "issue3=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #4 - timeline trim in/out markers" },
    @{ Branch="sweagent/issue-5";  Url=(($IssueLines | Where-Object { $_ -like "issue4=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #5 - ffmpeg.wasm export worker" },
    @{ Branch="sweagent/issue-7";  Url=(($IssueLines | Where-Object { $_ -like "issue5=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #7 - agent gateway EditPlan" },
    @{ Branch="sweagent/issue-8";  Url=(($IssueLines | Where-Object { $_ -like "issue6=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #8 - local events log JSONL" },
    @{ Branch="sweagent/issue-9";  Url=(($IssueLines | Where-Object { $_ -like "issue7=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #9 - evaluation harness" },
    @{ Branch="sweagent/issue-10"; Url=(($IssueLines | Where-Object { $_ -like "issue8=*" } | Select-Object -First 1).Split("=",2)[1]).Trim(); Commit="fix: issue #10 - nightly improvement script" }
)

foreach ($issue in $Issues) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Starting: $($issue.Branch)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    git checkout master 2>&1 | Out-Null
    git pull origin master 2>&1 | Out-Null
    git checkout -B $issue.Branch

    $Before = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss")

    wsl -d Ubuntu-24.04 -- bash -lc "cd $WslRepo && export GITHUB_TOKEN='$GhToken' && export OLLAMA_API_BASE='http://host.docker.internal:11434' && source ~/SWE-agent/.venv/bin/activate && sweagent run --config ~/SWE-agent/config/default.yaml --config ~/SWE-agent/config/ollama_override.yaml --env.repo.github_url='https://github.com/$RepoFull' --problem_statement.github_url='$($issue.Url)' --actions.apply_patch_locally True"

    $Patch = wsl -d Ubuntu-24.04 -- bash -lc "find $WslRepo/trajectories -name '*.patch' -newer <(date -d '$Before' '+%Y%m%d%H%M%S') 2>/dev/null | sort | tail -1"

    if ([string]::IsNullOrWhiteSpace($Patch)) {
        $Patch = wsl -d Ubuntu-24.04 -- bash -lc "find $WslRepo/trajectories -name '*.patch' | sort | tail -1"
    }

    if ([string]::IsNullOrWhiteSpace($Patch)) {
        Write-Host "WARNING: No patch found for $($issue.Branch) - skipping" -ForegroundColor Red
        continue
    }

    $PatchSize = wsl -d Ubuntu-24.04 -- bash -lc "wc -c < '$Patch'"
    if ([int]$PatchSize -lt 10) {
        Write-Host "WARNING: Patch is empty for $($issue.Branch) - skipping" -ForegroundColor Red
        continue
    }

    Write-Host "Applying patch: $Patch" -ForegroundColor Yellow
    wsl -d Ubuntu-24.04 -- bash -lc "cd $WslRepo && git apply --whitespace=fix '$Patch'"

    if ($LASTEXITCODE -ne 0) {
        wsl -d Ubuntu-24.04 -- bash -lc "cd $WslRepo && git apply --reject --whitespace=fix '$Patch'"
    }

    git add -A
    git commit -m $issue.Commit
    git push -u origin HEAD
    gh pr create --repo $RepoFull --base master --title $issue.Commit --body "Closes $($issue.Url)" --draft

    Write-Host "Done: $($issue.Branch)" -ForegroundColor Green
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "All issues completed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

# Stops ffmpeg processes left behind by Fluent IPTV.
#
# Windows does not terminate child processes when a parent is killed, so a
# force-closed app can leave transcoders running. This matches on our own ffmpeg
# argument (`-force_key_frames`, which only this app passes) instead of killing
# every ffmpeg on the machine, so unrelated encodes are left alone.
#
# Usage: npm run stop:orphans

$marker = '-force_key_frames'
$targets = Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) }

if (-not $targets) {
    Write-Host 'No Fluent IPTV ffmpeg processes are running.'
    exit 0
}

foreach ($process in $targets) {
    Write-Host ("stopping ffmpeg pid {0}" -f $process.ProcessId)
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host ("stopped {0} process(es)" -f $targets.Count)
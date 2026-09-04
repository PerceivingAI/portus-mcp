param(
    [string]$ProfileName = "portus-local",
    [string]$InstallDir = "C:\tools\tunnel-client",
    [string]$Port = "8789"
)

$ErrorActionPreference = "Stop"

# 1. Resolve tunnel-client automatically
$tunnelExe = "$InstallDir\tunnel-client.exe"
if (Get-Command "tunnel-client.exe" -ErrorAction SilentlyContinue) {
    $tunnelExe = (Get-Command "tunnel-client.exe").Source
} elseif (!(Test-Path $tunnelExe)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
    $release = Invoke-RestMethod "https://api.github.com/repos/openai/tunnel-client/releases/latest" -Headers @{"User-Agent"="tunnel-setup"}
    $asset = $release.assets | Where-Object { $_.name -like "*windows-$arch.zip" } | Select-Object -First 1
    $zip = "$InstallDir\tc.zip"
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip
    Expand-Archive $zip -DestinationPath $InstallDir -Force
    Remove-Item $zip -Force
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$userPath", "User")
        $env:Path = "$InstallDir;" + $env:Path
    }
}

# 2. API Key
$currentKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User")
if ([string]::IsNullOrWhiteSpace($currentKey)) { $currentKey = $env:CONTROL_PLANE_API_KEY }

if (![string]::IsNullOrWhiteSpace($currentKey)) {
    $useExisting = Read-Host "Use existing API Key (${currentKey:0:8}...)? (Y/n)"
    if ($useExisting -eq "n" -or $useExisting -eq "N") {
        $currentKey = $null
    }
}

if ([string]::IsNullOrWhiteSpace($currentKey)) {
    Start-Process "https://platform.openai.com/settings/organization/api-keys"
    while ($true) {
        $key = (Read-Host "Enter OpenAI API Key (sk-...)").Trim()
        if ($key -like "sk-*") {
            [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY", $key, "User")
            $env:CONTROL_PLANE_API_KEY = $key
            break
        }
        Write-Host "Must start with 'sk-'."
    }
} else {
    $env:CONTROL_PLANE_API_KEY = $currentKey
}

# 3. Tunnel ID & Notice
Write-Host "`nOpenAI UI Notice:
In the OpenAI Platform 'Create tunnel' modal:
- Name and Description are marked with a red asterisk (*) as required.
- Organizations comes pre-selected.
- 'ChatGPT workspaces' does not have an asterisk, but it is MANDATORY.

If you do not select a workspace from the dropdown, the platform will create the tunnel, but the ChatGPT plugin modal will not list or connect to it.`n"

Start-Process "https://platform.openai.com/settings/organization/tunnels"

$tunnelId = ""
while ($true) {
    $id = (Read-Host "Enter Tunnel ID (tunnel_...)").Trim()
    if ($id -like "tunnel_*") {
        $tunnelId = $id
        break
    }
    Write-Host "Must start with 'tunnel_'."
}

# 4. Generate profile using Portus MCP port (default 8789)
$mcpUrl = "http://127.0.0.1:$Port/mcp"

& $tunnelExe init `
    --profile $ProfileName `
    --tunnel-id $tunnelId `
    --mcp-server-url $mcpUrl `
    --health-listen-addr "127.0.0.1:0" `
    --force | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "Profile creation failed."
    exit 1
}

Write-Host "`nSetup complete. To launch Portus MCP with the tunnel, run:`n  npm run start:tunnel"

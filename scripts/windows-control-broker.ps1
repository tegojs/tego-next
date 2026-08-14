param(
  [string]$Endpoint,
  [object]$ParentProcessId,
  [object]$ProtocolVersion,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($args.Count -ne 0) {
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID")
  exit 1
}

if (
  [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
  -not [Environment]::Is64BitProcess -or
  [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") -ne "AMD64"
) {
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_ARCH_UNSUPPORTED")
  exit 1
}

if (
  $SelfTest -and (
    $PSVersionTable.PSVersion.Major -ne 5 -or
    $PSVersionTable.PSVersion.Minor -ne 1
  )
) {
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_POWERSHELL_UNSUPPORTED")
  exit 1
}

if ($SelfTest) {
  if (
    -not [string]::IsNullOrEmpty($Endpoint) -or
    $null -ne $ParentProcessId -or
    $null -ne $ProtocolVersion
  ) {
    [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID")
    exit 1
  }
} elseif (
  [string]::IsNullOrEmpty($Endpoint) -or
  $Endpoint -notmatch '^\\\\\.\\pipe\\[^\\\r\n]{1,200}$' -or
  $null -eq $ParentProcessId -or
  $null -eq $ProtocolVersion
) {
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID")
  exit 1
}

$sourcePath = Join-Path $PSScriptRoot "windows-control-broker.cs"
try {
  if (-not [IO.Path]::IsPathRooted($sourcePath) -or -not [IO.File]::Exists($sourcePath)) {
    throw "missing source"
  }
  Add-Type -Path $sourcePath
} catch {
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_COMPILE_FAILED")
  exit 1
}

try {
  if ($SelfTest) {
    exit [TegoWindowsControlBroker]::SelfTest()
  }

  $parentId = 0
  $version = 0
  if (
    -not [int]::TryParse([string]$ParentProcessId, [ref]$parentId) -or
    -not [int]::TryParse([string]$ProtocolVersion, [ref]$version) -or
    $parentId -lt 1 -or
    $version -ne 1
  ) {
    [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_ARGUMENTS_INVALID")
    exit 1
  }
  exit [TegoWindowsControlBroker]::Run($Endpoint, $parentId, $version)
} catch {
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_START_FAILED")
  exit 1
}

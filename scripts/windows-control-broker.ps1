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
if (-not [IO.Path]::IsPathRooted($sourcePath) -or -not [IO.File]::Exists($sourcePath)) {
  # TEMPORARY NON-AUTHORITATIVE TASK 4 DIAGNOSTIC. Remove after the compiler RED is localized.
  $diagnosticCode = "TEGO_TASK4_NON_AUTHORITATIVE_COMPILE_{0}" -f "SOURCE_MISSING"
  [Console]::Error.WriteLine($diagnosticCode)
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_COMPILE_FAILED")
  exit 1
}
try {
  [void][IO.File]::ReadAllBytes($sourcePath)
} catch {
  # TEMPORARY NON-AUTHORITATIVE TASK 4 DIAGNOSTIC. Remove after the compiler RED is localized.
  $diagnosticCode = "TEGO_TASK4_NON_AUTHORITATIVE_COMPILE_{0}" -f "SOURCE_READ"
  [Console]::Error.WriteLine($diagnosticCode)
  [Console]::Error.WriteLine("TEGO_WINDOWS_CONTROL_BROKER_COMPILE_FAILED")
  exit 1
}
try {
  Add-Type -Path $sourcePath
} catch {
  # TEMPORARY NON-AUTHORITATIVE TASK 4 DIAGNOSTIC. Remove after the compiler RED is localized.
  $addTypeCategory = "OTHER"
  if ($Error.Count -gt 0) {
    $addTypeId = [string]$Error[0].FullyQualifiedErrorId
    if ($addTypeId -match '^SOURCE_CODE_ERROR,') { $addTypeCategory = "SOURCE" }
    elseif ($addTypeId -match '^COMPILER_ERRORS,') { $addTypeCategory = "COMPILER" }
  }
  $compilerCode = "NONE"
  $compilerLine = 0
  $compilerLineBand = "L0"
  $compilerPath = Join-Path ([Environment]::GetEnvironmentVariable("WINDIR")) "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  $compilerOutputPath = Join-Path ([IO.Path]::GetTempPath()) (("tego-task4-{0}.dll" -f [Guid]::NewGuid().ToString("N")))
  if ([IO.File]::Exists($compilerPath)) {
    try {
      $compilerTranscript = & $compilerPath "/nologo" "/target:library" (("/out:{0}" -f $compilerOutputPath)) $sourcePath 2>&1
      $compilerExitCode = $LASTEXITCODE
      if ($compilerExitCode -ne 0) {
        $compilerMatch = [regex]::Match(
          ([string[]]$compilerTranscript -join "`n"),
          '\((\d+),\d+\)\s*:\s*(?:fatal\s+)?error\s+(CS\d{4})\b',
          [Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
        if ($compilerMatch.Success) {
          $compilerCode = $compilerMatch.Groups[2].Value.ToUpperInvariant()
          $compilerLine = [int]$compilerMatch.Groups[1].Value
        }
      } else {
        $compilerCode = "SUCCESS"
        $compilerLine = 0
      }
    } catch {
      $compilerCode = "SPAWN"
      $compilerLine = 0
    } finally {
      try { [IO.File]::Delete($compilerOutputPath) } catch {}
    }
    if ($compilerLine -ge 1) {
      if ($compilerLine -le 500) { $compilerLineBand = "L1" }
      elseif ($compilerLine -le 1000) { $compilerLineBand = "L2" }
      elseif ($compilerLine -le 1500) { $compilerLineBand = "L3" }
      elseif ($compilerLine -le 2000) { $compilerLineBand = "L4" }
      elseif ($compilerLine -le 2500) { $compilerLineBand = "L5" }
      elseif ($compilerLine -le 3000) { $compilerLineBand = "L6" }
    }
  } else {
    $compilerCode = "MISSING"
  }
  $diagnosticCode = "TEGO_TASK4_NON_AUTHORITATIVE_COMPILE_{0}_{1}_{2}" -f $addTypeCategory, $compilerCode, $compilerLineBand
  [Console]::Error.WriteLine($diagnosticCode)
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

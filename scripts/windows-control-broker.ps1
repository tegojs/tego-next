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
  # TEMPORARY NON-AUTHORITATIVE TASK 4 DIAGNOSTIC. Remove after the compiler RED is localized.
  $compilerError = $null
  if ($Error.Count -gt 0 -and $Error[0].TargetObject -is [System.CodeDom.Compiler.CompilerError]) {
    $compilerError = $Error[0].TargetObject
  } else {
    foreach ($record in $Error) {
      if ($record.TargetObject -is [System.CodeDom.Compiler.CompilerError]) {
        $compilerError = $record.TargetObject
        break
      }
    }
  }
  $compilerCategory = "OTHER"
  $compilerLineBand = "L0"
  if ($null -ne $compilerError) {
    switch -Regex ([string]$compilerError.ErrorNumber) {
      '^CS(?:1001|1002|1003|1026|1056|1513|1519|1525|1644|8026)$' {
        $compilerCategory = "SYNTAX"
      }
      '^CS(?:0103|0117|0122|0234|0246)$' { $compilerCategory = "SYMBOL" }
      '^CS(?:0029|0266|1501|1502|1503)$' { $compilerCategory = "TYPE" }
      '^CS(?:0165|0177)$' { $compilerCategory = "STATE" }
      '^CS(?:0012|1705)$' { $compilerCategory = "ASSEMBLY" }
    }
    $compilerLine = [int]$compilerError.Line
    if ($compilerLine -ge 1) {
      if ($compilerLine -le 500) { $compilerLineBand = "L1" }
      elseif ($compilerLine -le 1000) { $compilerLineBand = "L2" }
      elseif ($compilerLine -le 1500) { $compilerLineBand = "L3" }
      elseif ($compilerLine -le 2000) { $compilerLineBand = "L4" }
      elseif ($compilerLine -le 2500) { $compilerLineBand = "L5" }
      elseif ($compilerLine -le 3000) { $compilerLineBand = "L6" }
    }
  }
  $diagnosticCode = "TEGO_TASK4_NON_AUTHORITATIVE_COMPILE_{0}_{1}" -f $compilerCategory, $compilerLineBand
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

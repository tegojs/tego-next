param(
  [Parameter(Mandatory = $true)]
  [string]$Endpoint,

  [ValidateSet("harden", "inspect")]
  [string]$Operation = "harden",

  [ValidateRange(0, 64)]
  [int]$BarrierCount = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Close-TegoResource {
  param([object]$Resource)
  if ($null -eq $Resource) { return }
  try { $Resource.Dispose() } catch { }
}

if (
  ($Operation -eq "harden" -and $BarrierCount -lt 1) -or
  ($Operation -eq "inspect" -and $BarrierCount -ne 0)
) {
  throw "Invalid pipe admission barrier configuration"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class TegoWindowsPipeSecurityNative
{
    [Flags]
    public enum DesiredAccess : uint
    {
        GenericRead = 0x80000000,
        GenericWrite = 0x40000000,
        ReadControl = 0x00020000,
        WriteDac = 0x00040000,
        WriteOwner = 0x00080000
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFile(
        string fileName,
        DesiredAccess desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool WaitNamedPipe(string name, uint timeout);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetKernelObjectSecurity(
        SafeFileHandle handle,
        uint securityInformation,
        byte[] securityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetKernelObjectSecurity(
        SafeFileHandle handle,
        uint securityInformation,
        byte[] securityDescriptor,
        uint length,
        out uint lengthNeeded);

    public static IDisposable StartWatchdog(int timeoutMilliseconds)
    {
        return new System.Threading.Timer(
            _ => Environment.FailFast("Windows pipe security helper exceeded its deadline"),
            null,
            timeoutMilliseconds,
            System.Threading.Timeout.Infinite);
    }
}
'@

$watchdog = $null
$handle = $null
$barrierHandle = $null
$barrierStream = $null
$reader = $null
$failureStage = $null
$failureWin32Code = $null
$allowedWin32Codes = @(2, 5, 87, 123, 231)
$stage = "INITIAL_OPEN"

try {
  $watchdog = [TegoWindowsPipeSecurityNative]::StartWatchdog(9000)

  $desiredAccess =
  [TegoWindowsPipeSecurityNative+DesiredAccess]::GenericRead -bor
  [TegoWindowsPipeSecurityNative+DesiredAccess]::GenericWrite -bor
  [TegoWindowsPipeSecurityNative+DesiredAccess]::ReadControl -bor
  [TegoWindowsPipeSecurityNative+DesiredAccess]::WriteDac
  $barrierDesiredAccess =
    [TegoWindowsPipeSecurityNative+DesiredAccess]::GenericRead -bor
    [TegoWindowsPipeSecurityNative+DesiredAccess]::GenericWrite
  $openExisting = [uint32]3
  $ownerSecurityInformation = [uint32]0x00000001
  $daclSecurityInformation = [uint32]0x00000004
  $protectedDaclSecurityInformation = [uint32]0x80000000
  $querySecurityInformation = $ownerSecurityInformation -bor $daclSecurityInformation
  $setSecurityInformation =
    $daclSecurityInformation -bor $protectedDaclSecurityInformation
  $barrierRequest = [Text.Encoding]::UTF8.GetBytes("TEGO_WINDOWS_PIPE_SECURITY_BARRIER_V1`n")
  $barrierAck = "TEGO_WINDOWS_PIPE_SECURITY_BARRIER_ACK_V1`n"
  $handle = [TegoWindowsPipeSecurityNative]::CreateFile(
    $Endpoint,
    $desiredAccess,
    0,
    [IntPtr]::Zero,
    $openExisting,
    0,
    [IntPtr]::Zero
  )

  if ($handle.IsInvalid) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [ComponentModel.Win32Exception]::new($errorCode, "Could not open the named pipe")
  }

  $stage = "IDENTITY"
  $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($Operation -eq "harden") {
    $stage = "APPLY_DESCRIPTOR"
    $allowedSids = @(
      $currentUserSid
      "S-1-5-18"
      "S-1-5-32-544"
    ) | Select-Object -Unique
    $sddl = "O:$currentUserSid" + "D:P"
    foreach ($sid in $allowedSids) {
      $sddl += "(A;;FA;;;$sid)"
    }
    $requestedDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    $requestedBytes = [byte[]]::new($requestedDescriptor.BinaryLength)
    $requestedDescriptor.GetBinaryForm($requestedBytes, 0)

    if (-not [TegoWindowsPipeSecurityNative]::SetKernelObjectSecurity(
      $handle,
      $setSecurityInformation,
      $requestedBytes
    )) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [ComponentModel.Win32Exception]::new($errorCode, "Could not secure the named pipe")
    }

    # startControlServer pins Node 26.5.0/libuv to one pre-posted instance. The
    # handle above consumes that original instance. These two acknowledged
    # connections then consume its first replacement and prove the following
    # replacement was created after the descriptor changed.
    for ($index = 0; $index -lt $BarrierCount; $index += 1) {
      $stage = "BARRIER_WAIT"
      if (-not [TegoWindowsPipeSecurityNative]::WaitNamedPipe($Endpoint, 1000)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [ComponentModel.Win32Exception]::new($errorCode, "Pipe barrier was unavailable")
      }
      $stage = "BARRIER_OPEN"
      $barrierHandle = [TegoWindowsPipeSecurityNative]::CreateFile(
        $Endpoint,
        $barrierDesiredAccess,
        0,
        [IntPtr]::Zero,
        $openExisting,
        0,
        [IntPtr]::Zero
      )
      if ($barrierHandle.IsInvalid) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [ComponentModel.Win32Exception]::new($errorCode, "Could not open the pipe barrier")
      }
      try {
        $stage = "BARRIER_IO"
        $barrierStream = [IO.FileStream]::new(
          $barrierHandle,
          [IO.FileAccess]::ReadWrite,
          4096,
          $false
        )
        try {
          $barrierStream.Write($barrierRequest, 0, $barrierRequest.Length)
          $barrierStream.Flush()
          $reader = [IO.StreamReader]::new(
            $barrierStream,
            [Text.Encoding]::UTF8,
            $false,
            4096,
            $true
          )
          try {
            $acknowledgement = $reader.ReadLine()
          } finally {
            $reader.Dispose()
            $reader = $null
          }
          if (("$acknowledgement`n") -ne $barrierAck) {
            throw "Pipe admission barrier acknowledgement was invalid"
          }
        } finally {
          $barrierStream.Dispose()
          $barrierStream = $null
        }
      } finally {
        if (-not $barrierHandle.IsClosed) { $barrierHandle.Dispose() }
        $barrierHandle = $null
      }
    }
  }

  $stage = "DESCRIPTOR_SIZE"
  $lengthNeeded = [uint32]0
  [void][TegoWindowsPipeSecurityNative]::GetKernelObjectSecurity(
    $handle,
    $querySecurityInformation,
    $null,
    0,
    [ref]$lengthNeeded
  )
  if ($lengthNeeded -eq 0) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [ComponentModel.Win32Exception]::new($errorCode, "Could not size the pipe descriptor")
  }

  $actualBytes = [byte[]]::new($lengthNeeded)
  $stage = "DESCRIPTOR_READ"
  if (-not [TegoWindowsPipeSecurityNative]::GetKernelObjectSecurity(
    $handle,
    $querySecurityInformation,
    $actualBytes,
    $lengthNeeded,
    [ref]$lengthNeeded
  )) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [ComponentModel.Win32Exception]::new($errorCode, "Could not inspect the pipe descriptor")
  }

  $stage = "DESCRIPTOR_PARSE"
  $actualDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($actualBytes, 0)
  $rules = @(
    foreach ($ace in $actualDescriptor.DiscretionaryAcl) {
      $type = switch ($ace.AceQualifier) {
        ([Security.AccessControl.AceQualifier]::AccessAllowed) { "allow"; break }
        ([Security.AccessControl.AceQualifier]::AccessDenied) { "deny"; break }
        default { "unknown"; break }
      }
      [ordered]@{
        sid = $ace.SecurityIdentifier.Value
        type = $type
        inherited = [bool]($ace.AceFlags -band [Security.AccessControl.AceFlags]::Inherited)
        accessMask = [uint32]$ace.AccessMask
      }
    }
  )
  $accessSids = @(
    foreach ($rule in $rules) {
      if ($rule.type -eq "allow") { $rule.sid }
    }
  )
  $result = [ordered]@{
    currentUserSid = $currentUserSid
    ownerSid = $actualDescriptor.Owner.Value
    accessSids = $accessSids
    protectedDacl = [bool](
      $actualDescriptor.ControlFlags -band
      [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
    )
    accessRules = $rules
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
} catch {
  $failureStage = $stage
  if ($_.Exception -is [ComponentModel.Win32Exception]) {
    $candidateWin32Code = [int]$_.Exception.NativeErrorCode
    if ($allowedWin32Codes -contains $candidateWin32Code) {
      $failureWin32Code = $candidateWin32Code
    }
  }
} finally {
  Close-TegoResource $reader
  Close-TegoResource $barrierStream
  Close-TegoResource $barrierHandle
  Close-TegoResource $handle
  Close-TegoResource $watchdog
}

if ($null -ne $failureStage) {
  $failureDiagnostic = "TEGO_WINDOWS_PIPE_SECURITY_${failureStage}_FAILED"
  if ($null -ne $failureWin32Code) { $failureDiagnostic += ":$failureWin32Code" }
  [Console]::Error.WriteLine($failureDiagnostic)
  exit 1
}

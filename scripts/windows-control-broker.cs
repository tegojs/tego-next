using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class TegoWindowsControlBroker
{
    private const int ProtocolVersion = 1;
    private const int HeaderBytes = 24;
    private const int MaxFrameBytes = 65536;
    private const int MaxConnectionBytes = 262144;
    private const int MaxTotalQueuedBytes = 262144;
    private const int MaxConnections = 64;
    private const int OperationTimeoutMilliseconds = 5000;
    private const int ShutdownTimeoutMilliseconds = 2000;
    private const int ConnectionJoinTimeoutMilliseconds = 25;
    private const int Magic0 = 0x54;
    private const int Magic1 = 0x47;
    private const int Magic2 = 0x42;
    private const int Magic3 = 0x50;
    private const int DescriptorPayloadVersion = 1;
    private const int DescriptorPayloadProtected = 1;
    private const int DescriptorPayloadHeaderBytes = 12;
    private const int DescriptorPayloadAceHeaderBytes = 12;

    private const ushort FrameReady = 1;
    private const ushort FrameOpen = 2;
    private const ushort FrameData = 3;
    private const ushort FrameEof = 4;
    private const ushort FrameClose = 5;
    private const ushort FrameFatal = 6;
    private const ushort FramePause = 7;
    private const ushort FrameResume = 8;
    private const ushort FrameCloseAll = 9;
    private const ushort FrameCloseAllAck = 10;

    private static readonly ushort[] BrokerToParentFrameTypes = new ushort[]
    {
        FrameReady,
        FrameOpen,
        FrameData,
        FrameEof,
        FrameClose,
        FrameFatal,
        FrameCloseAllAck
    };

    private static readonly ushort[] ParentToBrokerFrameTypes = new ushort[]
    {
        FrameData,
        FrameClose,
        FramePause,
        FrameResume,
        FrameCloseAll
    };

    private const string LocalSystemSid = "S-1-5-18";
    private const string AdministratorsSid = "S-1-5-32-544";
    private const uint PipeFullControl = 0x001F01FF;
    private const uint Synchronize = 0x00100000;
    private const uint PipeAccessDuplex = 0x00000003;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileFlagFirstPipeInstance = 0x00080000;
    private const uint FileFlagOverlapped = 0x40000000;
    private const uint OpenExisting = 3;
    private const uint PipeTypeByte = 0x00000000;
    private const uint PipeReadModeByte = 0x00000000;
    private const uint PipeWait = 0x00000000;
    private const uint PipeRejectRemoteClients = 0x00000008;
    private const uint OwnerSecurityInformation = 0x00000001;
    private const uint DaclSecurityInformation = 0x00000004;
    private const int ErrorIoPending = 997;
    private const int ErrorOperationAborted = 995;
    private const int ErrorPipeConnected = 535;
    private const int ErrorBrokenPipe = 109;
    private const int ErrorNoData = 232;
    private const int WaitObject0 = 0;
    private const int WaitTimeout = 258;
    private const ushort ImageFileMachineUnknown = 0x0000;
    private const ushort ImageFileMachineAmd64 = 0x8664;

    private enum FailureStage
    {
        ParentOpen,
        Descriptor,
        PipeCreate,
        PipeVerify,
        Connect,
        Io,
        Protocol,
        Resource,
        SelfTest,
        Start
    }

    private enum ReadCancellationReason
    {
        None,
        Pause,
        Close
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        internal int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NATIVE_OVERLAPPED
    {
        internal IntPtr Internal;
        internal IntPtr InternalHigh;
        internal uint Offset;
        internal uint OffsetHigh;
        internal IntPtr EventHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateNamedPipeW(
        string name,
        uint openMode,
        uint pipeMode,
        uint maximumInstances,
        uint outputBufferSize,
        uint inputBufferSize,
        uint defaultTimeout,
        ref SECURITY_ATTRIBUTES securityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetKernelObjectSecurity(
        SafeFileHandle handle,
        uint securityInformation,
        byte[] securityDescriptor,
        uint length,
        out uint lengthNeeded);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConnectNamedPipe(SafeFileHandle handle, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(
        SafeFileHandle handle,
        IntPtr buffer,
        uint bytesToRead,
        IntPtr bytesRead,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(
        SafeFileHandle handle,
        IntPtr buffer,
        uint bytesToWrite,
        IntPtr bytesWritten,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetOverlappedResult(
        SafeFileHandle handle,
        IntPtr overlapped,
        out uint transferred,
        [MarshalAs(UnmanagedType.Bool)] bool wait);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWow64Process2(
        IntPtr process,
        out ushort processMachine,
        out ushort nativeMachine);

    private sealed class SecurityDescriptorContext : IDisposable
    {
        private readonly byte[] _bytes;
        private GCHandle _pinned;
        private bool _disposed;

        internal SecurityDescriptorContext(byte[] bytes, SecurityIdentifier[] expectedSids)
        {
            _bytes = bytes;
            ExpectedSids = expectedSids;
            _pinned = GCHandle.Alloc(_bytes, GCHandleType.Pinned);
        }

        internal SecurityIdentifier[] ExpectedSids { get; private set; }
        internal int DescriptorLength { get { return _bytes.Length; } }

        internal SECURITY_ATTRIBUTES Attributes()
        {
            if (_disposed)
                throw new ObjectDisposedException("SecurityDescriptorContext");
            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            attributes.lpSecurityDescriptor = _pinned.AddrOfPinnedObject();
            attributes.bInheritHandle = 0;
            return attributes;
        }

        public void Dispose()
        {
            if (_disposed)
                return;
            _disposed = true;
            if (_pinned.IsAllocated)
                _pinned.Free();
        }
    }

    private sealed class BrokerFrame
    {
        internal ushort Type;
        internal ulong ConnectionId;
        internal byte[] Payload;
    }

    private sealed class ClosedConnectionState
    {
        internal bool BrokerCloseSeen;
        internal bool ParentCloseSeen;
        internal DateTime DeadlineUtc;
    }

    private sealed class PendingCloseTracker
    {
        private readonly Dictionary<ulong, ClosedConnectionState> _states =
            new Dictionary<ulong, ClosedConnectionState>();

        internal int Count { get { return _states.Count; } }

        internal bool CanAdmit(int activeConnections)
        {
            if (activeConnections < 0 || activeConnections > MaxConnections)
                throw new InvalidDataException();
            return activeConnections + _states.Count < MaxConnections;
        }

        internal void AddBrokerFirst(ulong id, DateTime deadlineUtc)
        {
            if (_states.Count >= MaxConnections || _states.ContainsKey(id))
                throw new InvalidDataException();
            ClosedConnectionState state = new ClosedConnectionState();
            state.BrokerCloseSeen = true;
            state.ParentCloseSeen = false;
            state.DeadlineUtc = deadlineUtc;
            _states.Add(id, state);
        }

        internal void AcknowledgeParent(ulong id)
        {
            ClosedConnectionState state;
            if (!_states.TryGetValue(id, out state) ||
                state.ParentCloseSeen ||
                !state.BrokerCloseSeen)
                throw new InvalidDataException();
            state.ParentCloseSeen = true;
            _states.Remove(id);
        }

        internal DateTime? EarliestDeadlineUtc()
        {
            DateTime? earliest = null;
            foreach (ClosedConnectionState state in _states.Values)
            {
                if (!earliest.HasValue || state.DeadlineUtc < earliest.Value)
                    earliest = state.DeadlineUtc;
            }
            return earliest;
        }

        internal bool HasExpired(DateTime nowUtc)
        {
            DateTime? earliest = EarliestDeadlineUtc();
            return earliest.HasValue && earliest.Value <= nowUtc;
        }

        internal void Clear()
        {
            _states.Clear();
        }
    }

    private sealed class ParentFrameReader
    {
        private readonly Stream _stream;

        internal ParentFrameReader(Stream stream)
        {
            _stream = stream;
        }

        internal BrokerFrame ReadFrame()
        {
            byte[] header = new byte[HeaderBytes];
            if (!ReadExact(_stream, header, 0, HeaderBytes, true))
                return null;
            if (header[0] != Magic0 || header[1] != Magic1 || header[2] != Magic2 || header[3] != Magic3)
                throw new InvalidDataException();
            if (ReadUInt16(header, 4) != ProtocolVersion)
                throw new InvalidDataException();
            ushort type = ReadUInt16(header, 6);
            if (!Contains(ParentToBrokerFrameTypes, type))
                throw new InvalidDataException();
            ulong connectionId = ReadUInt64(header, 8);
            uint length = ReadUInt32(header, 16);
            if (length > MaxFrameBytes || header[20] != 0 || header[21] != 0 || header[22] != 0 || header[23] != 0)
                throw new InvalidDataException();
            if ((type == FrameCloseAll && connectionId != 0) || (type != FrameCloseAll && connectionId == 0))
                throw new InvalidDataException();
            if (type != FrameData && length != 0)
                throw new InvalidDataException();
            byte[] payload = new byte[(int)length];
            if (payload.Length != 0 && !ReadExact(_stream, payload, 0, payload.Length, false))
                throw new InvalidDataException();
            BrokerFrame frame = new BrokerFrame();
            frame.Type = type;
            frame.ConnectionId = connectionId;
            frame.Payload = payload;
            return frame;
        }
    }

    private sealed class ParentFrameWriter : IDisposable
    {
        internal sealed class PreparedFrame
        {
            internal byte[] Bytes;
            internal DateTime Deadline;
            internal long Ticket;
        }

        private readonly Stream _stream;
        private readonly object _sequenceGate = new object();
        private bool _disposed;
        private bool _failed;
        private long _nextTicket;
        private long _servingTicket;

        internal ParentFrameWriter(Stream stream)
        {
            _stream = stream;
        }

        internal PreparedFrame PrepareFrame(ushort type, ulong connectionId, byte[] payload)
        {
            if (!Contains(BrokerToParentFrameTypes, type) || payload == null || payload.Length > MaxFrameBytes)
                throw new InvalidDataException();
            bool global = type == FrameReady || type == FrameFatal || type == FrameCloseAllAck;
            if ((global && connectionId != 0) || (!global && connectionId == 0))
                throw new InvalidDataException();
            byte[] frame = new byte[HeaderBytes + payload.Length];
            frame[0] = Magic0;
            frame[1] = Magic1;
            frame[2] = Magic2;
            frame[3] = Magic3;
            WriteUInt16(frame, 4, ProtocolVersion);
            WriteUInt16(frame, 6, type);
            WriteUInt64(frame, 8, connectionId);
            WriteUInt32(frame, 16, (uint)payload.Length);
            Buffer.BlockCopy(payload, 0, frame, HeaderBytes, payload.Length);
            lock (_sequenceGate)
            {
                if (_disposed || _failed || _nextTicket == long.MaxValue)
                    throw new ObjectDisposedException("ParentFrameWriter");
                PreparedFrame prepared = new PreparedFrame();
                prepared.Bytes = frame;
                prepared.Deadline = DateTime.UtcNow.AddMilliseconds(OperationTimeoutMilliseconds);
                prepared.Ticket = _nextTicket;
                _nextTicket += 1;
                return prepared;
            }
        }

        internal void WritePrepared(PreparedFrame prepared)
        {
            bool sequenceFailure = false;
            lock (_sequenceGate)
            {
                while (!_failed && !_disposed && prepared.Ticket != _servingTicket)
                {
                    TimeSpan remaining = prepared.Deadline - DateTime.UtcNow;
                    if (remaining <= TimeSpan.Zero)
                    {
                        _failed = true;
                        sequenceFailure = true;
                        Monitor.PulseAll(_sequenceGate);
                        break;
                    }
                    Monitor.Wait(_sequenceGate, remaining);
                }
                if (_failed || _disposed)
                    sequenceFailure = true;
            }
            if (sequenceFailure)
            {
                _stream.Dispose();
                throw new IOException();
            }

            Exception failure = null;
            try
            {
                IAsyncResult write = _stream.BeginWrite(
                    prepared.Bytes,
                    0,
                    prepared.Bytes.Length,
                    null,
                    null);
                try
                {
                    TimeSpan remaining = prepared.Deadline - DateTime.UtcNow;
                    if (remaining <= TimeSpan.Zero || !write.AsyncWaitHandle.WaitOne(remaining))
                        throw new IOException();
                    _stream.EndWrite(write);
                }
                finally
                {
                    write.AsyncWaitHandle.Close();
                }
            }
            catch (Exception exception)
            {
                failure = exception;
            }
            finally
            {
                lock (_sequenceGate)
                {
                    if (failure != null)
                        _failed = true;
                    if (prepared.Ticket == _servingTicket)
                        _servingTicket += 1;
                    Monitor.PulseAll(_sequenceGate);
                }
            }
            if (failure != null)
            {
                _stream.Dispose();
                throw new IOException();
            }
        }

        internal void WriteFrame(ushort type, ulong connectionId, byte[] payload)
        {
            WritePrepared(PrepareFrame(type, connectionId, payload));
        }

        public void Dispose()
        {
            lock (_sequenceGate)
            {
                if (_disposed)
                    return;
                _disposed = true;
                _failed = true;
                Monitor.PulseAll(_sequenceGate);
            }
            _stream.Dispose();
        }
    }

    private sealed class OverlappedOperation : IDisposable
    {
        private readonly SafeFileHandle _pipeHandle;
        private readonly ManualResetEvent _shutdown;
        private readonly object _stateGate = new object();
        private ManualResetEvent _completed;
        private GCHandle _bufferPin;
        private bool _bufferPinned;
        private bool _safeFileReference;
        private bool _cancellationRequested;
        private bool _cancellationDispatched;
        private bool _unsafeKernelState;
        private bool _issued;
        private bool _settled;
        private bool _disposeStarted;
        private bool _disposed;
        private IntPtr _nativeOverlapped;

        internal OverlappedOperation(SafeFileHandle handle, byte[] buffer, ManualResetEvent shutdown)
        {
            _pipeHandle = handle;
            _shutdown = shutdown;
            bool addRef = false;
            try
            {
                _pipeHandle.DangerousAddRef(ref addRef);
                _safeFileReference = addRef;
                _completed = new ManualResetEvent(false);
                if (buffer != null)
                {
                    _bufferPin = GCHandle.Alloc(buffer, GCHandleType.Pinned);
                    _bufferPinned = true;
                    BufferPointer = _bufferPin.AddrOfPinnedObject();
                }
                _nativeOverlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NATIVE_OVERLAPPED)));
                NATIVE_OVERLAPPED native = new NATIVE_OVERLAPPED();
                native.EventHandle = _completed.SafeWaitHandle.DangerousGetHandle();
                Marshal.StructureToPtr(native, _nativeOverlapped, false);
            }
            catch
            {
                if (_nativeOverlapped != IntPtr.Zero)
                {
                    try
                    {
                        Marshal.FreeHGlobal(_nativeOverlapped);
                    }
                    catch
                    {
                    }
                }
                if (_bufferPinned)
                {
                    try
                    {
                        _bufferPin.Free();
                    }
                    catch
                    {
                    }
                    _bufferPinned = false;
                }
                if (_completed != null)
                {
                    try
                    {
                        _completed.Dispose();
                    }
                    catch
                    {
                    }
                }
                if (_safeFileReference)
                {
                    try
                    {
                        _pipeHandle.DangerousRelease();
                    }
                    catch
                    {
                    }
                    _safeFileReference = false;
                }
                throw;
            }
        }

        internal IntPtr BufferPointer { get; private set; }
        internal IntPtr Pointer { get { return _nativeOverlapped; } }
        internal int ErrorCode { get; private set; }

        private bool MarkIssued()
        {
            if (_disposed || _issued || _settled)
                throw new InvalidOperationException();
            _issued = true;
            if (_cancellationRequested)
            {
                _issued = false;
                _settled = true;
                ErrorCode = ErrorOperationAborted;
                _completed.Set();
                return false;
            }
            return true;
        }

        internal bool IssueConnect(out int errorCode)
        {
            lock (_stateGate)
            {
                if (!MarkIssued())
                {
                    errorCode = ErrorOperationAborted;
                    return false;
                }
                bool synchronous;
                try
                {
                    synchronous = ConnectNamedPipe(_pipeHandle, _nativeOverlapped);
                    errorCode = synchronous ? 0 : Marshal.GetLastWin32Error();
                }
                catch
                {
                    _unsafeKernelState = true;
                    FailFastResource();
                    errorCode = ErrorOperationAborted;
                    return false;
                }
                SettleImmediateIssueFailure(synchronous, errorCode);
                return synchronous;
            }
        }

        internal bool IssueRead(uint bytesToRead, out int errorCode)
        {
            lock (_stateGate)
            {
                if (!MarkIssued())
                {
                    errorCode = ErrorOperationAborted;
                    return false;
                }
                bool synchronous;
                try
                {
                    synchronous = ReadFile(
                        _pipeHandle,
                        BufferPointer,
                        bytesToRead,
                        IntPtr.Zero,
                        _nativeOverlapped);
                    errorCode = synchronous ? 0 : Marshal.GetLastWin32Error();
                }
                catch
                {
                    _unsafeKernelState = true;
                    FailFastResource();
                    errorCode = ErrorOperationAborted;
                    return false;
                }
                SettleImmediateIssueFailure(synchronous, errorCode);
                return synchronous;
            }
        }

        internal bool IssueWrite(uint bytesToWrite, out int errorCode)
        {
            lock (_stateGate)
            {
                if (!MarkIssued())
                {
                    errorCode = ErrorOperationAborted;
                    return false;
                }
                bool synchronous;
                try
                {
                    synchronous = WriteFile(
                        _pipeHandle,
                        BufferPointer,
                        bytesToWrite,
                        IntPtr.Zero,
                        _nativeOverlapped);
                    errorCode = synchronous ? 0 : Marshal.GetLastWin32Error();
                }
                catch
                {
                    _unsafeKernelState = true;
                    FailFastResource();
                    errorCode = ErrorOperationAborted;
                    return false;
                }
                SettleImmediateIssueFailure(synchronous, errorCode);
                return synchronous;
            }
        }

        private void SettleImmediateIssueFailure(bool synchronous, int errorCode)
        {
            if (!synchronous && errorCode != ErrorIoPending)
            {
                _issued = false;
                _settled = true;
                ErrorCode = errorCode;
                _completed.Set();
            }
        }

        internal void MarkCompletedWithoutIo()
        {
            MarkCompletedWithoutIo(0);
        }

        internal void MarkCompletedWithoutIo(int errorCode)
        {
            lock (_stateGate)
            {
                _issued = false;
                _settled = true;
                ErrorCode = errorCode;
                _completed.Set();
            }
        }

        internal void RequestCancellation()
        {
            lock (_stateGate)
            {
                if (_disposed || _settled)
                    return;
                _cancellationRequested = true;
                if (!_issued)
                    return;
                if (_cancellationDispatched)
                    return;
                _cancellationDispatched = true;
                try
                {
                    CancelIoEx(_pipeHandle, _nativeOverlapped);
                }
                catch
                {
                    _unsafeKernelState = true;
                    FailFastResource();
                }
            }
        }

        internal bool Complete(int timeoutMilliseconds, out uint transferred)
        {
            try
            {
                WaitHandle[] waitHandles = new WaitHandle[] { _completed, _shutdown };
                int result = timeoutMilliseconds == Timeout.Infinite
                    ? WaitHandle.WaitAny(waitHandles)
                    : WaitHandle.WaitAny(waitHandles, timeoutMilliseconds);
                if (result != 0)
                {
                    RequestCancellation();
                    if (!_completed.WaitOne(OperationTimeoutMilliseconds))
                        FailFastResource();
                }
                return SettleKernelOperation(out transferred);
            }
            catch
            {
                lock (_stateGate)
                {
                    _unsafeKernelState = true;
                }
                FailFastResource();
                transferred = 0;
                return false;
            }
        }

        private bool SettleKernelOperation(out uint transferred)
        {
            lock (_stateGate)
            {
                transferred = 0;
                if (_settled)
                    return ErrorCode == 0;
                if (!_issued)
                {
                    _settled = true;
                    return ErrorCode == 0;
                }
                bool success;
                try
                {
                    success = GetOverlappedResult(
                        _pipeHandle,
                        _nativeOverlapped,
                        out transferred,
                        false);
                }
                catch
                {
                    _unsafeKernelState = true;
                    FailFastResource();
                    return false;
                }
                int error = success ? 0 : Marshal.GetLastWin32Error();
                ErrorCode = error;
                _settled = true;
                if (!success && error != ErrorBrokenPipe && error != ErrorNoData &&
                    error != ErrorOperationAborted)
                    FailFastResource();
                return success;
            }
        }

        public void Dispose()
        {
            bool cleanupFailure = false;
            lock (_stateGate)
            {
                if (_disposed || _disposeStarted)
                    return;
                _disposeStarted = true;
            }
            bool needsSettlement;
            lock (_stateGate)
            {
                if (_unsafeKernelState)
                {
                    FailFastResource();
                    return;
                }
                needsSettlement = _issued && !_settled;
            }
            if (needsSettlement)
            {
                try
                {
                    RequestCancellation();
                    if (!_completed.WaitOne(ShutdownTimeoutMilliseconds))
                        FailFastResource();
                    uint ignored;
                    SettleKernelOperation(out ignored);
                }
                catch
                {
                    lock (_stateGate)
                    {
                        _unsafeKernelState = true;
                    }
                    FailFastResource();
                    return;
                }
            }
            lock (_stateGate)
            {
                if (_unsafeKernelState || (_issued && !_settled))
                {
                    FailFastResource();
                    return;
                }
                _disposed = true;
            }
            if (_nativeOverlapped != IntPtr.Zero)
            {
                try
                {
                    Marshal.FreeHGlobal(_nativeOverlapped);
                }
                catch
                {
                    cleanupFailure = true;
                }
                _nativeOverlapped = IntPtr.Zero;
            }
            if (_bufferPinned)
            {
                try
                {
                    _bufferPin.Free();
                }
                catch
                {
                    cleanupFailure = true;
                }
                _bufferPinned = false;
            }
            if (_completed != null)
            {
                try
                {
                    _completed.Dispose();
                }
                catch
                {
                    cleanupFailure = true;
                }
                _completed = null;
            }
            if (_safeFileReference)
            {
                try
                {
                    _pipeHandle.DangerousRelease();
                }
                catch
                {
                    cleanupFailure = true;
                }
                _safeFileReference = false;
            }
            if (cleanupFailure)
            {
                EmitStage(FailureStage.Resource);
                throw new InvalidOperationException();
            }
        }
    }

    private sealed class ParentProcessWatchdog : IDisposable
    {
        private readonly SafeWaitHandle _parentHandle;
        private readonly Action _parentExited;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly ManualResetEvent _entered = new ManualResetEvent(false);
        private readonly Thread _thread;
        private bool _disposed;

        internal ParentProcessWatchdog(SafeWaitHandle parentHandle, Action parentExited)
        {
            _parentHandle = parentHandle;
            _parentExited = parentExited;
            _thread = new Thread(new ThreadStart(Watch));
            _thread.IsBackground = true;
            _thread.Name = "tego-broker-parent-watch";
        }

        internal void Start()
        {
            _thread.Start();
        }

        internal bool WaitUntilWatchdogEntered()
        {
            return _entered.WaitOne(OperationTimeoutMilliseconds);
        }

        private void Watch()
        {
            _entered.Set();
            while (!_stop.WaitOne(0))
            {
                uint result = WaitForSingleObject(_parentHandle, 100);
                if (result == WaitObject0)
                {
                    _parentExited();
                    return;
                }
                if (result != WaitTimeout)
                {
                    _parentExited();
                    return;
                }
            }
        }

        public void Dispose()
        {
            if (_disposed)
                return;
            _disposed = true;
            _stop.Set();
            if (_thread.IsAlive && !_thread.Join(ShutdownTimeoutMilliseconds))
                FailFastResource();
            _parentHandle.Dispose();
            _entered.Dispose();
            _stop.Dispose();
        }
    }

    private sealed class PendingReadOperation
    {
        private readonly object _gate = new object();
        private readonly OverlappedOperation _operation;
        private ReadCancellationReason _cancellationReason;

        internal PendingReadOperation(long generation, OverlappedOperation operation)
        {
            Generation = generation;
            _operation = operation;
            _cancellationReason = ReadCancellationReason.None;
        }

        internal long Generation { get; private set; }

        internal ReadCancellationReason CancellationReason
        {
            get
            {
                lock (_gate)
                {
                    return _cancellationReason;
                }
            }
        }

        internal void Cancel(ReadCancellationReason reason)
        {
            lock (_gate)
            {
                if (_cancellationReason == ReadCancellationReason.None)
                    _cancellationReason = reason;
                _operation.RequestCancellation();
            }
        }
    }

    private sealed class PipeConnection : IDisposable
    {
        private readonly Broker _broker;
        private readonly SafeFileHandle _pipeHandle;
        private readonly ManualResetEvent _shutdown;
        private readonly ManualResetEvent _writePublishedForSelfTest;
        private readonly ManualResetEvent _writeContinueForSelfTest;
        private readonly ManualResetEvent _writeCancellationObservedForSelfTest;
        private readonly ManualResetEvent _pauseGate = new ManualResetEvent(true);
        private readonly ManualResetEvent _readStopped = new ManualResetEvent(true);
        private readonly ManualResetEvent _writeIdle = new ManualResetEvent(true);
        private readonly object _readGate = new object();
        private readonly object _writeGate = new object();
        private readonly object _startGate = new object();
        private readonly Thread _readThread;
        private PendingReadOperation _pendingRead;
        private OverlappedOperation _activeWrite;
        private long _readGeneration;
        private int _closed;
        private int _paused;
        private int _started;
        private int _synchronizationDisposed;
        private int _disposeSynchronizationOnReadExit;

        internal PipeConnection(Broker broker, SafeFileHandle handle, ulong id)
            : this(broker, handle, id, broker.Shutdown, null, null, null)
        {
        }

        internal PipeConnection(
            Broker broker,
            SafeFileHandle handle,
            ulong id,
            ManualResetEvent shutdown,
            ManualResetEvent writePublishedForSelfTest,
            ManualResetEvent writeContinueForSelfTest,
            ManualResetEvent writeCancellationObservedForSelfTest)
        {
            _broker = broker;
            _pipeHandle = handle;
            _shutdown = shutdown;
            _writePublishedForSelfTest = writePublishedForSelfTest;
            _writeContinueForSelfTest = writeContinueForSelfTest;
            _writeCancellationObservedForSelfTest = writeCancellationObservedForSelfTest;
            Id = id;
            _readThread = new Thread(new ThreadStart(ReadLoop));
            _readThread.IsBackground = true;
            _readThread.Name = "tego-broker-pipe-read";
        }

        internal ulong Id { get; private set; }

        internal void Start()
        {
            lock (_startGate)
            {
                if (Interlocked.CompareExchange(ref _closed, 0, 0) != 0)
                    return;
                if (Interlocked.Exchange(ref _started, 1) != 0)
                    throw new InvalidOperationException();
                _readStopped.Reset();
                _readThread.Start();
            }
        }

        internal void Pause()
        {
            lock (_readGate)
            {
                if (Interlocked.CompareExchange(ref _closed, 0, 0) != 0 || _paused != 0)
                    throw new InvalidDataException();
                _paused = 1;
                _pauseGate.Reset();
                PendingReadOperation pendingRead = _pendingRead;
                if (pendingRead != null)
                    pendingRead.Cancel(ReadCancellationReason.Pause);
            }
        }

        internal void Resume()
        {
            lock (_readGate)
            {
                if (Interlocked.CompareExchange(ref _closed, 0, 0) != 0 || _paused != 1)
                    throw new InvalidDataException();
                _paused = 0;
                _pauseGate.Set();
            }
        }

        internal bool Write(byte[] payload)
        {
            OverlappedOperation operation;
            lock (_writeGate)
            {
                if (Interlocked.CompareExchange(ref _closed, 0, 0) != 0 || _activeWrite != null)
                    return false;
                operation = new OverlappedOperation(_pipeHandle, payload, _shutdown);
                _activeWrite = operation;
                _writeIdle.Reset();
            }
            if (_writePublishedForSelfTest != null)
            {
                _writePublishedForSelfTest.Set();
                if (!_writeContinueForSelfTest.WaitOne(OperationTimeoutMilliseconds))
                    FailFastResource();
            }
            try
            {
                int error;
                bool synchronous = operation.IssueWrite((uint)payload.Length, out error);
                if (!synchronous)
                {
                    if (error != ErrorIoPending)
                        return false;
                }
                uint transferred;
                if (!operation.Complete(OperationTimeoutMilliseconds, out transferred))
                    return false;
                return transferred == payload.Length;
            }
            finally
            {
                try
                {
                    operation.Dispose();
                }
                finally
                {
                    lock (_writeGate)
                    {
                        if (Object.ReferenceEquals(_activeWrite, operation))
                            _activeWrite = null;
                        _writeIdle.Set();
                    }
                }
            }
        }

        private void ReadLoop()
        {
            byte[] buffer = new byte[MaxFrameBytes];
            try
            {
                while (!_shutdown.WaitOne(0) && Interlocked.CompareExchange(ref _closed, 0, 0) == 0)
                {
                    int pauseResult = WaitHandle.WaitAny(new WaitHandle[] { _pauseGate, _shutdown });
                    if (pauseResult != 0)
                        return;
                    uint transferred = 0;
                    using (OverlappedOperation operation = new OverlappedOperation(_pipeHandle, buffer, _shutdown))
                    {
                        bool synchronous;
                        int readError = 0;
                        PendingReadOperation pendingRead;
                        lock (_readGate)
                        {
                            if (_paused != 0)
                            {
                                operation.MarkCompletedWithoutIo();
                                continue;
                            }
                            if (_readGeneration == long.MaxValue)
                                throw new InvalidOperationException();
                            _readGeneration += 1;
                            pendingRead = new PendingReadOperation(_readGeneration, operation);
                            _pendingRead = pendingRead;
                            synchronous = operation.IssueRead((uint)buffer.Length, out readError);
                        }
                        bool completed = false;
                        try
                        {
                            if (synchronous || readError == ErrorIoPending)
                                completed = operation.Complete(Timeout.Infinite, out transferred);
                        }
                        finally
                        {
                            lock (_readGate)
                            {
                                if (_pendingRead != null &&
                                    _pendingRead.Generation == pendingRead.Generation)
                                    _pendingRead = null;
                            }
                        }
                        if (!completed)
                        {
                            if (ShouldRetryCanceledRead(
                                operation.ErrorCode,
                                pendingRead,
                                Interlocked.CompareExchange(ref _closed, 0, 0) != 0,
                                _shutdown.WaitOne(0)))
                                continue;
                            if (operation.ErrorCode == ErrorBrokenPipe || operation.ErrorCode == ErrorNoData)
                                _broker.ClientEof(this);
                            return;
                        }
                    }
                    if (transferred == 0)
                    {
                        _broker.ClientEof(this);
                        return;
                    }
                    byte[] payload = new byte[(int)transferred];
                    Buffer.BlockCopy(buffer, 0, payload, 0, payload.Length);
                    bool forwarded = false;
                    while (!forwarded && !_shutdown.WaitOne(0))
                    {
                        int forwardResult = WaitHandle.WaitAny(new WaitHandle[] { _pauseGate, _shutdown });
                        if (forwardResult != 0)
                            return;
                        ParentFrameWriter.PreparedFrame prepared = null;
                        lock (_readGate)
                        {
                            if (_paused == 0)
                                prepared = _broker.PrepareClientData(this, payload);
                        }
                        if (prepared == null)
                        {
                            if (Interlocked.CompareExchange(ref _paused, 0, 0) != 0)
                                continue;
                            return;
                        }
                        _broker.WriteClientData(prepared, payload.Length);
                        forwarded = true;
                    }
                }
            }
            catch
            {
                _broker.ClientFailed(this);
            }
            finally
            {
                _readStopped.Set();
                if (Interlocked.CompareExchange(ref _disposeSynchronizationOnReadExit, 0, 0) != 0)
                    DisposeSynchronizationObjects();
            }
        }

        private void RequestIoCancellation()
        {
            _pauseGate.Set();
            lock (_readGate)
            {
                PendingReadOperation pendingRead = _pendingRead;
                if (pendingRead != null)
                    pendingRead.Cancel(ReadCancellationReason.Close);
            }
            lock (_writeGate)
            {
                if (_activeWrite != null)
                {
                    _activeWrite.RequestCancellation();
                    if (_writeCancellationObservedForSelfTest != null)
                        _writeCancellationObservedForSelfTest.Set();
                }
            }
        }

        private void WaitForIoSettlement()
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds);
            bool onReadThread = Thread.CurrentThread == _readThread;
            if (!onReadThread && Interlocked.CompareExchange(ref _started, 0, 0) != 0 &&
                !WaitUntil(_readStopped, deadline))
                FailFastResource();
            if (!WaitUntil(_writeIdle, deadline))
                FailFastResource();
        }

        private static bool WaitUntil(WaitHandle waitHandle, DateTime deadline)
        {
            TimeSpan remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero)
                return waitHandle.WaitOne(0);
            return waitHandle.WaitOne(remaining);
        }

        private void DisposeSynchronizationObjects()
        {
            if (Interlocked.Exchange(ref _synchronizationDisposed, 1) != 0)
                return;
            _pauseGate.Dispose();
            _readStopped.Dispose();
            _writeIdle.Dispose();
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _closed, 1) != 0)
                return;
            lock (_startGate)
            {
            }
            RequestIoCancellation();
            WaitForIoSettlement();
            _pipeHandle.Dispose();
            if (Thread.CurrentThread == _readThread)
                Interlocked.Exchange(ref _disposeSynchronizationOnReadExit, 1);
            else
                DisposeSynchronizationObjects();
        }
    }

    private static bool ShouldRetryCanceledRead(
        int errorCode,
        PendingReadOperation pendingRead,
        bool closing,
        bool shuttingDown)
    {
        return errorCode == ErrorOperationAborted &&
            pendingRead.CancellationReason == ReadCancellationReason.Pause &&
            !closing &&
            !shuttingDown;
    }

    private sealed class Broker : IDisposable
    {
        private readonly string _endpoint;
        private readonly SecurityDescriptorContext _security;
        private readonly byte[] _readyDescriptor;
        private readonly ParentFrameWriter _writer;
        private readonly Stream _input;
        private readonly object _gate = new object();
        private readonly object _outputGate = new object();
        private readonly Dictionary<ulong, PipeConnection> _connections = new Dictionary<ulong, PipeConnection>();
        private readonly PendingCloseTracker _pendingCloses = new PendingCloseTracker();
        private readonly Timer _closeDeadlineTimer;
        private readonly ManualResetEvent _readyGate = new ManualResetEvent(false);
        private readonly ManualResetEvent _firstAcceptArmed = new ManualResetEvent(false);
        private readonly AutoResetEvent _connectionSlot = new AutoResetEvent(false);
        private readonly ManualResetEvent _acceptCancellation = new ManualResetEvent(false);
        private readonly ManualResetEvent _acceptStopped = new ManualResetEvent(true);
        private readonly ManualResetEvent _shutdown = new ManualResetEvent(false);
        private ParentProcessWatchdog _watchdog;
        private SafeFileHandle _firstPipe;
        private SafeFileHandle _pendingPipe;
        private Thread _acceptThread;
        private Thread _inputThread;
        private ulong _nextConnectionId;
        private int _queuedBytes;
        private bool _closing;
        private bool _failed;
        private bool _closeAllAckQueued;
        private bool _closeAllAcknowledged;
        private bool _disposed;

        internal Broker(
            string endpoint,
            SecurityDescriptorContext security,
            byte[] readyDescriptor,
            SafeFileHandle firstPipe,
            ParentFrameWriter writer,
            Stream input,
            SafeWaitHandle parentHandle)
        {
            _endpoint = endpoint;
            _security = security;
            _readyDescriptor = readyDescriptor;
            _firstPipe = firstPipe;
            _writer = writer;
            _input = input;
            _watchdog = new ParentProcessWatchdog(parentHandle, new Action(ParentExited));
            _closeDeadlineTimer = new Timer(
                new TimerCallback(CloseDeadlineElapsed),
                null,
                Timeout.Infinite,
                Timeout.Infinite);
        }

        internal ManualResetEvent Shutdown { get { return _shutdown; } }

        internal int Execute()
        {
            _watchdog.Start();
            _acceptThread = new Thread(new ThreadStart(AcceptLoop));
            _acceptThread.IsBackground = true;
            _acceptThread.Name = "tego-broker-accept";
            _acceptStopped.Reset();
            _acceptThread.Start();
            if (!_firstAcceptArmed.WaitOne(OperationTimeoutMilliseconds))
            {
                Fail(FailureStage.Connect);
                return 1;
            }
            _writer.WriteFrame(FrameReady, 0, _readyDescriptor);
            _readyGate.Set();
            _inputThread = new Thread(new ThreadStart(InputLoop));
            _inputThread.IsBackground = true;
            _inputThread.Name = "tego-broker-parent-input";
            _inputThread.Start();
            _shutdown.WaitOne();
            CloseEveryPipe();
            return _failed ? 1 : 0;
        }

        private void AcceptLoop()
        {
            bool first = true;
            try
            {
                while (!_shutdown.WaitOne(0))
                {
                    while (ConnectionCount() >= MaxConnections && !_shutdown.WaitOne(0))
                        WaitHandle.WaitAny(new WaitHandle[] { _connectionSlot, _shutdown });
                    if (_shutdown.WaitOne(0))
                        return;
                    SafeFileHandle pipe;
                    if (first)
                    {
                        pipe = _firstPipe;
                        _firstPipe = null;
                    }
                    else
                    {
                        pipe = CreateVerifiedPipe(_endpoint, _security, false);
                    }
                    lock (_gate)
                    {
                        if (_closing)
                        {
                            pipe.Dispose();
                            return;
                        }
                        _pendingPipe = pipe;
                    }
                    bool connected = WaitForConnection(
                        pipe,
                        first ? _firstAcceptArmed : null,
                        _acceptCancellation);
                    first = false;
                    lock (_gate)
                    {
                        _pendingPipe = null;
                    }
                    if (!connected)
                    {
                        pipe.Dispose();
                        if (_shutdown.WaitOne(0))
                            return;
                        throw new IOException();
                    }
                    _readyGate.WaitOne();
                    PipeConnection connection;
                    ParentFrameWriter.PreparedFrame openFrame;
                    lock (_outputGate)
                    {
                        lock (_gate)
                        {
                            if (_closing)
                            {
                                pipe.Dispose();
                                return;
                            }
                            if (_nextConnectionId == ulong.MaxValue)
                                throw new InvalidDataException();
                            _nextConnectionId += 1;
                            connection = new PipeConnection(this, pipe, _nextConnectionId);
                            _connections.Add(connection.Id, connection);
                        }
                        openFrame = _writer.PrepareFrame(FrameOpen, connection.Id, new byte[0]);
                    }
                    _writer.WritePrepared(openFrame);
                    connection.Start();
                }
            }
            catch
            {
                _firstAcceptArmed.Set();
                if (!IsClosing())
                    Fail(FailureStage.Connect);
            }
            finally
            {
                _acceptStopped.Set();
            }
        }

        private void InputLoop()
        {
            ParentFrameReader reader = new ParentFrameReader(_input);
            try
            {
                while (!_shutdown.WaitOne(0))
                {
                    BrokerFrame frame = reader.ReadFrame();
                    if (frame == null)
                    {
                        ParentExited();
                        return;
                    }
                    if (frame.Type == FrameCloseAll)
                    {
                        CloseAllFromParent();
                        return;
                    }
                    if (frame.Type == FrameClose)
                    {
                        CloseFromParent(frame.ConnectionId);
                        continue;
                    }
                    PipeConnection connection = FindConnection(frame.ConnectionId);
                    if (frame.Type == FrameData)
                    {
                        if (frame.Payload.Length > MaxConnectionBytes || !connection.Write(frame.Payload))
                            CloseConnection(connection, true);
                    }
                    else if (frame.Type == FramePause)
                    {
                        connection.Pause();
                    }
                    else if (frame.Type == FrameResume)
                    {
                        connection.Resume();
                    }
                    else
                    {
                        throw new InvalidDataException();
                    }
                }
            }
            catch
            {
                if (!_shutdown.WaitOne(0))
                    Fail(FailureStage.Protocol);
            }
        }

        internal ParentFrameWriter.PreparedFrame PrepareClientData(
            PipeConnection connection,
            byte[] payload)
        {
            if (!ReserveQueue(payload.Length))
            {
                CloseConnection(connection, true);
                return null;
            }
            lock (_outputGate)
            {
                if (!IsClosing() && ContainsConnection(connection))
                {
                    try
                    {
                        return _writer.PrepareFrame(FrameData, connection.Id, payload);
                    }
                    catch
                    {
                        ReleaseQueue(payload.Length);
                        throw;
                    }
                }
                ReleaseQueue(payload.Length);
                return null;
            }
        }

        internal void WriteClientData(ParentFrameWriter.PreparedFrame prepared, int payloadLength)
        {
            try
            {
                _writer.WritePrepared(prepared);
            }
            catch
            {
                Fail(FailureStage.Io);
            }
            finally
            {
                ReleaseQueue(payloadLength);
            }
        }

        internal void ClientEof(PipeConnection connection)
        {
            ParentFrameWriter.PreparedFrame eofFrame = null;
            try
            {
                lock (_outputGate)
                {
                    if (!IsClosing() && ContainsConnection(connection))
                        eofFrame = _writer.PrepareFrame(FrameEof, connection.Id, new byte[0]);
                }
                if (eofFrame != null)
                    _writer.WritePrepared(eofFrame);
            }
            catch
            {
                Fail(FailureStage.Io);
            }
        }

        internal void ClientFailed(PipeConnection connection)
        {
            CloseConnection(connection, true);
        }

        private void CloseConnection(PipeConnection connection, bool brokerFirst)
        {
            bool removed;
            bool endpointClosing;
            bool pendingResolved = false;
            ParentFrameWriter.PreparedFrame closeFrame = null;
            lock (_outputGate)
            {
                lock (_gate)
                {
                    removed = _connections.Remove(connection.Id);
                    endpointClosing = _closing;
                    if (removed && brokerFirst && !endpointClosing)
                    {
                        _pendingCloses.AddBrokerFirst(
                            connection.Id,
                            DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds));
                        ScheduleCloseDeadlineLocked();
                    }
                    else if (!removed && !brokerFirst)
                    {
                        _pendingCloses.AcknowledgeParent(connection.Id);
                        ScheduleCloseDeadlineLocked();
                        pendingResolved = true;
                    }
                }
                if (removed && !endpointClosing && !_shutdown.WaitOne(0))
                    closeFrame = _writer.PrepareFrame(FrameClose, connection.Id, new byte[0]);
            }
            if (!removed)
            {
                if (pendingResolved)
                    _connectionSlot.Set();
                return;
            }
            if (closeFrame != null)
            {
                try
                {
                    _writer.WritePrepared(closeFrame);
                }
                catch
                {
                    Fail(FailureStage.Io);
                }
            }
            connection.Dispose();
            _connectionSlot.Set();
        }

        private void CloseFromParent(ulong id)
        {
            PipeConnection connection;
            bool pendingResolved = false;
            lock (_gate)
            {
                if (!_connections.TryGetValue(id, out connection))
                {
                    _pendingCloses.AcknowledgeParent(id);
                    ScheduleCloseDeadlineLocked();
                    pendingResolved = true;
                }
            }
            if (pendingResolved)
            {
                _connectionSlot.Set();
                return;
            }
            CloseConnection(connection, false);
        }

        private void ScheduleCloseDeadlineLocked()
        {
            DateTime? earliest = _pendingCloses.EarliestDeadlineUtc();
            if (_closing || !earliest.HasValue)
            {
                _closeDeadlineTimer.Change(Timeout.Infinite, Timeout.Infinite);
                return;
            }
            double remaining = (earliest.Value - DateTime.UtcNow).TotalMilliseconds;
            int dueTime = remaining <= 1
                ? 1
                : (int)Math.Min(Math.Ceiling(remaining), ShutdownTimeoutMilliseconds);
            _closeDeadlineTimer.Change(dueTime, Timeout.Infinite);
        }

        private void CloseDeadlineElapsed(object unused)
        {
            bool expired;
            lock (_gate)
            {
                if (_closing)
                    return;
                expired = _pendingCloses.HasExpired(DateTime.UtcNow);
                if (!expired)
                    ScheduleCloseDeadlineLocked();
            }
            if (expired)
                Fail(FailureStage.Protocol);
        }

        private void CloseAllFromParent()
        {
            ParentFrameWriter.PreparedFrame[] terminalFrames;
            lock (_outputGate)
            {
                BeginClosing();
                PipeConnection[] connections;
                lock (_gate)
                {
                    connections = new PipeConnection[_connections.Count];
                    _connections.Values.CopyTo(connections, 0);
                }
                terminalFrames = new ParentFrameWriter.PreparedFrame[connections.Length];
                for (int index = 0; index < connections.Length; index += 1)
                    terminalFrames[index] = _writer.PrepareFrame(
                        FrameClose,
                        connections[index].Id,
                        new byte[0]);
            }
            for (int index = 0; index < terminalFrames.Length; index += 1)
                _writer.WritePrepared(terminalFrames[index]);
            CloseEveryPipe();
            ParentFrameWriter.PreparedFrame acknowledgement;
            lock (_outputGate)
            {
                lock (_gate)
                {
                    if (_failed)
                        return;
                }
                acknowledgement = _writer.PrepareFrame(FrameCloseAllAck, 0, new byte[0]);
                lock (_gate)
                {
                    _closeAllAckQueued = true;
                }
            }
            try
            {
                _writer.WritePrepared(acknowledgement);
                lock (_gate)
                {
                    _closeAllAcknowledged = true;
                }
                _shutdown.Set();
            }
            catch
            {
                lock (_gate)
                {
                    _failed = true;
                }
                EmitStage(FailureStage.Io);
                _shutdown.Set();
            }
        }

        private void ParentExited()
        {
            BeginClosing();
            CloseEveryPipe();
            _shutdown.Set();
        }

        private void Fail(FailureStage stage)
        {
            ParentFrameWriter.PreparedFrame fatalFrame;
            lock (_outputGate)
            {
                lock (_gate)
                {
                    if (_failed || _closing || _closeAllAckQueued || _closeAllAcknowledged)
                        return;
                    _failed = true;
                    _closing = true;
                }
                try
                {
                    fatalFrame = _writer.PrepareFrame(
                        FrameFatal,
                        0,
                        Encoding.ASCII.GetBytes(StageCode(stage)));
                }
                catch
                {
                    fatalFrame = null;
                }
            }
            if (fatalFrame != null)
            {
                try
                {
                    _writer.WritePrepared(fatalFrame);
                }
                catch
                {
                }
            }
            EmitStage(stage);
            CloseEveryPipe();
            _shutdown.Set();
        }

        private void BeginClosing()
        {
            lock (_gate)
            {
                _closing = true;
            }
            _readyGate.Set();
            _connectionSlot.Set();
        }

        private void CloseEveryPipe()
        {
            PipeConnection[] connections;
            lock (_gate)
            {
                _closing = true;
                connections = new PipeConnection[_connections.Count];
                _connections.Values.CopyTo(connections, 0);
                _connections.Clear();
                _pendingCloses.Clear();
                _closeDeadlineTimer.Change(Timeout.Infinite, Timeout.Infinite);
            }
            StopAcceptLoop();
            for (int index = 0; index < connections.Length; index += 1)
                connections[index].Dispose();
            _connectionSlot.Set();
        }

        private void StopAcceptLoop()
        {
            _acceptCancellation.Set();
            _readyGate.Set();
            _connectionSlot.Set();
            Thread acceptThread = _acceptThread;
            if (acceptThread != null && Thread.CurrentThread != acceptThread)
            {
                if (!_acceptStopped.WaitOne(ShutdownTimeoutMilliseconds))
                    FailFastResource();
                if (acceptThread.IsAlive && !acceptThread.Join(0))
                    FailFastResource();
            }
            DisposePendingAcceptHandle();
        }

        private void DisposePendingAcceptHandle()
        {
            SafeFileHandle pending;
            lock (_gate)
            {
                pending = _pendingPipe;
                _pendingPipe = null;
            }
            if (pending != null)
                pending.Dispose();
        }

        private int ConnectionCount()
        {
            lock (_gate)
            {
                return _connections.Count + _pendingCloses.Count;
            }
        }

        private PipeConnection FindConnection(ulong id)
        {
            lock (_gate)
            {
                PipeConnection connection;
                if (!_connections.TryGetValue(id, out connection))
                    throw new InvalidDataException();
                return connection;
            }
        }

        private bool ContainsConnection(PipeConnection connection)
        {
            lock (_gate)
            {
                PipeConnection actual;
                return _connections.TryGetValue(connection.Id, out actual) && Object.ReferenceEquals(actual, connection);
            }
        }

        private bool IsClosing()
        {
            lock (_gate)
            {
                return _closing;
            }
        }

        private bool ReserveQueue(int bytes)
        {
            lock (_gate)
            {
                if (bytes < 0 || bytes > MaxConnectionBytes || _queuedBytes > MaxTotalQueuedBytes - bytes)
                    return false;
                _queuedBytes += bytes;
                return true;
            }
        }

        private void ReleaseQueue(int bytes)
        {
            lock (_gate)
            {
                _queuedBytes -= bytes;
                if (_queuedBytes < 0)
                    throw new InvalidDataException();
            }
        }

        public void Dispose()
        {
            if (_disposed)
                return;
            _disposed = true;
            BeginClosing();
            _shutdown.Set();
            CloseEveryPipe();
            _input.Dispose();
            if (_acceptThread != null && _acceptThread.IsAlive)
                _acceptThread.Join(ShutdownTimeoutMilliseconds);
            if (_inputThread != null && _inputThread.IsAlive)
                _inputThread.Join(ShutdownTimeoutMilliseconds);
            using (ManualResetEvent timerStopped = new ManualResetEvent(false))
            {
                if (!_closeDeadlineTimer.Dispose(timerStopped) ||
                    !timerStopped.WaitOne(ShutdownTimeoutMilliseconds))
                    FailFastResource();
            }
            if (_firstPipe != null)
                _firstPipe.Dispose();
            _watchdog.Dispose();
            _security.Dispose();
            _readyGate.Dispose();
            _firstAcceptArmed.Dispose();
            _connectionSlot.Dispose();
            _acceptStopped.Dispose();
            _acceptCancellation.Dispose();
            _shutdown.Dispose();
            _writer.Dispose();
        }
    }

    private sealed class SelfTestPipePair : IDisposable
    {
        private int _disposed;

        internal SelfTestPipePair(SafeFileHandle server, SafeFileHandle client)
        {
            Server = server;
            Client = client;
        }

        internal SafeFileHandle Server { get; private set; }
        internal SafeFileHandle Client { get; private set; }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;
            Client.Dispose();
            Server.Dispose();
        }
    }

    private static SecurityDescriptorContext CreateSecurityDescriptor()
    {
        SecurityIdentifier currentUserSid = WindowsIdentity.GetCurrent().User;
        if (currentUserSid == null)
            throw new InvalidOperationException();
        List<SecurityIdentifier> expected = new List<SecurityIdentifier>();
        AddUniqueSid(expected, currentUserSid);
        AddUniqueSid(expected, new SecurityIdentifier(LocalSystemSid));
        AddUniqueSid(expected, new SecurityIdentifier(AdministratorsSid));
        RawAcl dacl = new RawAcl(GenericAcl.AclRevision, expected.Count);
        for (int index = 0; index < expected.Count; index += 1)
        {
            CommonAce ace = new CommonAce(
                AceFlags.None,
                AceQualifier.AccessAllowed,
                (int)PipeFullControl,
                expected[index],
                false,
                null);
            dacl.InsertAce(index, ace);
        }
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(
            ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected,
            currentUserSid,
            null,
            null,
            dacl);
        byte[] bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        return new SecurityDescriptorContext(bytes, expected.ToArray());
    }

    private static void AddUniqueSid(List<SecurityIdentifier> sids, SecurityIdentifier sid)
    {
        for (int index = 0; index < sids.Count; index += 1)
        {
            if (sids[index].Equals(sid))
                return;
        }
        sids.Add(sid);
    }

    private static SafeWaitHandle OpenParentProcess(int parentProcessId)
    {
        SafeWaitHandle parentHandle = OpenProcess(Synchronize, false, parentProcessId);
        if (parentHandle == null || parentHandle.IsInvalid)
        {
            if (parentHandle != null)
                parentHandle.Dispose();
            throw new InvalidOperationException();
        }
        return parentHandle;
    }

    private static SafeFileHandle CreateVerifiedPipe(
        string endpoint,
        SecurityDescriptorContext descriptor,
        bool firstInstance)
    {
        SECURITY_ATTRIBUTES securityAttributes = descriptor.Attributes();
        uint openMode = PipeAccessDuplex | FileFlagOverlapped;
        if (firstInstance)
            openMode |= FileFlagFirstPipeInstance;
        SafeFileHandle handle = CreateNamedPipeW(
            endpoint,
            openMode,
            PipeTypeByte | PipeReadModeByte | PipeWait | PipeRejectRemoteClients,
            MaxConnections,
            MaxFrameBytes,
            MaxFrameBytes,
            0,
            ref securityAttributes);
        if (handle == null || handle.IsInvalid)
        {
            if (handle != null)
                handle.Dispose();
            throw new InvalidOperationException();
        }
        try
        {
            SecurityIdentifier[] expectedSids = descriptor.ExpectedSids;
            VerifyDescriptor(handle, expectedSids);
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void VerifyDescriptor(SafeFileHandle handle, SecurityIdentifier[] expectedSids)
    {
        uint lengthNeeded;
        GetKernelObjectSecurity(
            handle,
            OwnerSecurityInformation | DaclSecurityInformation,
            null,
            0,
            out lengthNeeded);
        if (lengthNeeded == 0 || lengthNeeded > MaxConnectionBytes)
            throw new InvalidOperationException();
        byte[] bytes = new byte[(int)lengthNeeded];
        if (!GetKernelObjectSecurity(
            handle,
            OwnerSecurityInformation | DaclSecurityInformation,
            bytes,
            lengthNeeded,
            out lengthNeeded))
            throw new InvalidOperationException();
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
        ValidateDescriptor(descriptor, expectedSids);
    }

    private static byte[] ReadReadyDescriptor(
        SafeFileHandle handle,
        SecurityIdentifier[] expectedSids)
    {
        uint lengthNeeded;
        GetKernelObjectSecurity(
            handle,
            OwnerSecurityInformation | DaclSecurityInformation,
            null,
            0,
            out lengthNeeded);
        if (lengthNeeded == 0 || lengthNeeded > MaxConnectionBytes)
            throw new InvalidOperationException();
        byte[] bytes = new byte[(int)lengthNeeded];
        if (!GetKernelObjectSecurity(
            handle,
            OwnerSecurityInformation | DaclSecurityInformation,
            bytes,
            lengthNeeded,
            out lengthNeeded))
            throw new InvalidOperationException();
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
        ValidateDescriptor(descriptor, expectedSids);

        byte[] ownerSid = Encoding.ASCII.GetBytes(descriptor.Owner.Value);
        byte[][] aceSids = new byte[descriptor.DiscretionaryAcl.Count][];
        int payloadLength = DescriptorPayloadHeaderBytes + ownerSid.Length;
        for (int index = 0; index < descriptor.DiscretionaryAcl.Count; index += 1)
        {
            CommonAce ace = descriptor.DiscretionaryAcl[index] as CommonAce;
            if (ace == null ||
                ace.IsCallback ||
                ace.AceFlags != AceFlags.None ||
                (uint)ace.AccessMask != PipeFullControl ||
                ace.SecurityIdentifier == null)
                throw new InvalidOperationException();
            aceSids[index] = Encoding.ASCII.GetBytes(ace.SecurityIdentifier.Value);
            payloadLength = checked(payloadLength + DescriptorPayloadAceHeaderBytes + aceSids[index].Length);
        }
        if (ownerSid.Length == 0 || ownerSid.Length > ushort.MaxValue ||
            aceSids.Length == 0 || aceSids.Length > ushort.MaxValue ||
            payloadLength > MaxFrameBytes)
            throw new InvalidOperationException();

        byte[] payload = new byte[payloadLength];
        payload[0] = 0x54;
        payload[1] = 0x47;
        payload[2] = 0x53;
        payload[3] = 0x44;
        WriteUInt16(payload, 4, DescriptorPayloadVersion);
        WriteUInt16(payload, 6, DescriptorPayloadProtected);
        WriteUInt16(payload, 8, ownerSid.Length);
        WriteUInt16(payload, 10, aceSids.Length);
        int offset = DescriptorPayloadHeaderBytes;
        Buffer.BlockCopy(ownerSid, 0, payload, offset, ownerSid.Length);
        offset += ownerSid.Length;
        for (int index = 0; index < descriptor.DiscretionaryAcl.Count; index += 1)
        {
            CommonAce ace = descriptor.DiscretionaryAcl[index] as CommonAce;
            byte[] aceSid = aceSids[index];
            payload[offset] = 1;
            payload[offset + 1] = 0;
            payload[offset + 2] = 0;
            payload[offset + 3] = 0;
            WriteUInt32(payload, offset + 4, (uint)ace.AccessMask);
            WriteUInt16(payload, offset + 8, aceSid.Length);
            WriteUInt16(payload, offset + 10, 0);
            offset += DescriptorPayloadAceHeaderBytes;
            Buffer.BlockCopy(aceSid, 0, payload, offset, aceSid.Length);
            offset += aceSid.Length;
        }
        if (offset != payload.Length)
            throw new InvalidOperationException();
        return payload;
    }

    private static void ValidateDescriptor(
        RawSecurityDescriptor descriptor,
        SecurityIdentifier[] expectedSids)
    {
        if (descriptor.Owner == null || !descriptor.Owner.Equals(expectedSids[0]))
            throw new InvalidOperationException();
        if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
            throw new InvalidOperationException();
        if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || descriptor.DiscretionaryAcl == null)
            throw new InvalidOperationException();
        if (descriptor.DiscretionaryAcl.Count != expectedSids.Length)
            throw new InvalidOperationException();
        for (int index = 0; index < descriptor.DiscretionaryAcl.Count; index += 1)
        {
            CommonAce ace = descriptor.DiscretionaryAcl[index] as CommonAce;
            byte[] opaque = ace == null ? null : ace.GetOpaque();
            if (ace == null ||
                ace.AceType != AceType.AccessAllowed ||
                ace.AceQualifier != AceQualifier.AccessAllowed ||
                ace.IsCallback ||
                (opaque != null && opaque.Length != 0) ||
                ace.AceFlags != AceFlags.None ||
                (uint)ace.AccessMask != PipeFullControl ||
                ace.SecurityIdentifier == null ||
                !ace.SecurityIdentifier.Equals(expectedSids[index]))
                throw new InvalidOperationException();
        }
    }

    private static bool WaitForConnection(
        SafeFileHandle handle,
        ManualResetEvent armed,
        ManualResetEvent shutdown)
    {
        using (OverlappedOperation operation = new OverlappedOperation(handle, null, shutdown))
        {
            int error;
            bool synchronous = operation.IssueConnect(out error);
            if (armed != null)
                armed.Set();
            if (synchronous)
            {
                uint synchronousBytes;
                return operation.Complete(OperationTimeoutMilliseconds, out synchronousBytes);
            }
            if (error == ErrorPipeConnected)
                return true;
            if (error != ErrorIoPending)
                return false;
            uint transferred;
            return operation.Complete(Timeout.Infinite, out transferred);
        }
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int offset, int count, bool allowEof)
    {
        int read = 0;
        while (read < count)
        {
            int current = stream.Read(buffer, offset + read, count - read);
            if (current == 0)
            {
                if (allowEof && read == 0)
                    return false;
                throw new InvalidDataException();
            }
            read += current;
        }
        return true;
    }

    private static bool Contains(ushort[] values, ushort value)
    {
        for (int index = 0; index < values.Length; index += 1)
        {
            if (values[index] == value)
                return true;
        }
        return false;
    }

    private static ushort ReadUInt16(byte[] buffer, int offset)
    {
        return (ushort)((buffer[offset] << 8) | buffer[offset + 1]);
    }

    private static uint ReadUInt32(byte[] buffer, int offset)
    {
        return ((uint)buffer[offset] << 24) |
            ((uint)buffer[offset + 1] << 16) |
            ((uint)buffer[offset + 2] << 8) |
            buffer[offset + 3];
    }

    private static ulong ReadUInt64(byte[] buffer, int offset)
    {
        ulong high = ReadUInt32(buffer, offset);
        ulong low = ReadUInt32(buffer, offset + 4);
        return (high << 32) | low;
    }

    private static void WriteUInt16(byte[] buffer, int offset, int value)
    {
        buffer[offset] = (byte)((value >> 8) & 0xff);
        buffer[offset + 1] = (byte)(value & 0xff);
    }

    private static void WriteUInt32(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)((value >> 24) & 0xff);
        buffer[offset + 1] = (byte)((value >> 16) & 0xff);
        buffer[offset + 2] = (byte)((value >> 8) & 0xff);
        buffer[offset + 3] = (byte)(value & 0xff);
    }

    private static void WriteUInt64(byte[] buffer, int offset, ulong value)
    {
        WriteUInt32(buffer, offset, (uint)(value >> 32));
        WriteUInt32(buffer, offset + 4, (uint)value);
    }

    private static string StageCode(FailureStage stage)
    {
        switch (stage)
        {
            case FailureStage.ParentOpen:
                return "TEGO_WINDOWS_CONTROL_BROKER_PARENT_OPEN_FAILED";
            case FailureStage.Descriptor:
                return "TEGO_WINDOWS_CONTROL_BROKER_DESCRIPTOR_FAILED";
            case FailureStage.PipeCreate:
                return "TEGO_WINDOWS_CONTROL_BROKER_PIPE_CREATE_FAILED";
            case FailureStage.PipeVerify:
                return "TEGO_WINDOWS_CONTROL_BROKER_PIPE_VERIFY_FAILED";
            case FailureStage.Connect:
                return "TEGO_WINDOWS_CONTROL_BROKER_CONNECT_FAILED";
            case FailureStage.Io:
                return "TEGO_WINDOWS_CONTROL_BROKER_IO_FAILED";
            case FailureStage.Protocol:
                return "TEGO_WINDOWS_CONTROL_BROKER_PROTOCOL_FAILED";
            case FailureStage.Resource:
                return "TEGO_WINDOWS_CONTROL_BROKER_RESOURCE_FAILED";
            case FailureStage.SelfTest:
                return "TEGO_WINDOWS_CONTROL_BROKER_SELF_TEST_FAILED";
            default:
                return "TEGO_WINDOWS_CONTROL_BROKER_START_FAILED";
        }
    }

    private static void EmitStage(FailureStage stage)
    {
        Console.Error.WriteLine(StageCode(stage));
    }

    private static void FailFastResource()
    {
        try
        {
            EmitStage(FailureStage.Resource);
        }
        catch
        {
        }
        try
        {
            TerminateProcess(GetCurrentProcess(), 1);
        }
        catch
        {
        }
        Environment.FailFast(StageCode(FailureStage.Resource));
    }

    private static bool IsX64Process()
    {
        ushort processMachine;
        ushort nativeMachine;
        if (!IsWow64Process2(GetCurrentProcess(), out processMachine, out nativeMachine))
            return false;
        if (nativeMachine != ImageFileMachineAmd64)
            return false;
        return processMachine == ImageFileMachineUnknown || processMachine == ImageFileMachineAmd64;
    }

    public static int Run(string endpoint, int parentProcessId, int protocolVersion)
    {
        if (!IsX64Process() || protocolVersion != ProtocolVersion || parentProcessId < 1 || String.IsNullOrEmpty(endpoint))
        {
            EmitStage(FailureStage.Start);
            return 1;
        }
        SafeWaitHandle parentHandle = null;
        SecurityDescriptorContext descriptor = null;
        SafeFileHandle firstPipe = null;
        ParentFrameWriter writer = null;
        Stream input = null;
        byte[] readyDescriptor = null;
        try
        {
            parentHandle = OpenParentProcess(parentProcessId);
            descriptor = CreateSecurityDescriptor();
            firstPipe = CreateVerifiedPipe(endpoint, descriptor, true);
            readyDescriptor = ReadReadyDescriptor(firstPipe, descriptor.ExpectedSids);
            writer = new ParentFrameWriter(Console.OpenStandardOutput());
            input = Console.OpenStandardInput();
            using (Broker broker = new Broker(
                endpoint,
                descriptor,
                readyDescriptor,
                firstPipe,
                writer,
                input,
                parentHandle))
            {
                descriptor = null;
                firstPipe = null;
                writer = null;
                input = null;
                parentHandle = null;
                return broker.Execute();
            }
        }
        catch
        {
            EmitStage(FailureStage.Start);
            return 1;
        }
        finally
        {
            if (input != null)
                input.Dispose();
            if (writer != null)
                writer.Dispose();
            if (firstPipe != null)
                firstPipe.Dispose();
            if (descriptor != null)
                descriptor.Dispose();
            if (parentHandle != null)
                parentHandle.Dispose();
        }
    }

    public static int SelfTest()
    {
        if (!IsX64Process())
        {
            EmitStage(FailureStage.SelfTest);
            return 1;
        }
        try
        {
            TestCodecConstants();
            TestDescriptorConstruction();
            TestParentWatchCancellation();
            TestInvalidFrameRejection();
            TestRepeatedResourceCleanup();
            TestPrivatePipeCancellation();
            TestWritePreIssueCancellation();
            TestPendingCloseAdmission();
            TestPauseImmediateResume();
            TestRepeatedPipeCleanup();
            return 0;
        }
        catch
        {
            EmitStage(FailureStage.SelfTest);
            return 1;
        }
    }

    private static void TestCodecConstants()
    {
        if (ProtocolVersion != 1 || HeaderBytes != 24 || MaxFrameBytes != 65536 ||
            BrokerToParentFrameTypes.Length != 7 || ParentToBrokerFrameTypes.Length != 5 ||
            FrameReady != 1 || FrameOpen != 2 || FrameData != 3 || FrameEof != 4 ||
            FrameClose != 5 || FrameFatal != 6 || FramePause != 7 || FrameResume != 8 ||
            FrameCloseAll != 9 || FrameCloseAllAck != 10)
            throw new InvalidOperationException();
    }

    private static void TestDescriptorConstruction()
    {
        using (SecurityDescriptorContext context = CreateSecurityDescriptor())
        {
            SECURITY_ATTRIBUTES attributes = context.Attributes();
            if (attributes.lpSecurityDescriptor == IntPtr.Zero || attributes.bInheritHandle != 0 ||
                context.ExpectedSids.Length < 2 || !context.ExpectedSids[0].Equals(WindowsIdentity.GetCurrent().User))
                throw new InvalidOperationException();
            byte[] bytes = new byte[context.DescriptorLength];
            Marshal.Copy(attributes.lpSecurityDescriptor, bytes, 0, bytes.Length);
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
            ValidateDescriptor(descriptor, context.ExpectedSids);
            if (descriptor.Owner == null || !descriptor.Owner.Equals(context.ExpectedSids[0]) ||
                (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
                descriptor.DiscretionaryAcl == null ||
                descriptor.DiscretionaryAcl.Count != context.ExpectedSids.Length)
                throw new InvalidOperationException();
            for (int index = 0; index < context.ExpectedSids.Length; index += 1)
            {
                CommonAce ace = descriptor.DiscretionaryAcl[index] as CommonAce;
                if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed ||
                    ace.AceFlags != AceFlags.None || (uint)ace.AccessMask != PipeFullControl ||
                    !ace.SecurityIdentifier.Equals(context.ExpectedSids[index]))
                    throw new InvalidOperationException();
            }

            RawAcl callbackDacl = new RawAcl(GenericAcl.AclRevision, context.ExpectedSids.Length);
            for (int index = 0; index < context.ExpectedSids.Length; index += 1)
            {
                bool callback = index == 0;
                CommonAce callbackAce = new CommonAce(
                    AceFlags.None,
                    AceQualifier.AccessAllowed,
                    (int)PipeFullControl,
                    context.ExpectedSids[index],
                    callback,
                    callback ? new byte[] { 1, 0, 0, 0 } : null);
                callbackDacl.InsertAce(index, callbackAce);
            }
            RawSecurityDescriptor callbackDescriptor = new RawSecurityDescriptor(
                ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected,
                context.ExpectedSids[0],
                null,
                null,
                callbackDacl);
            bool callbackRejected = false;
            try
            {
                ValidateDescriptor(callbackDescriptor, context.ExpectedSids);
            }
            catch (InvalidOperationException)
            {
                callbackRejected = true;
            }
            if (!callbackRejected)
                throw new InvalidOperationException();
        }
    }

    private static void TestParentWatchCancellation()
    {
        SafeWaitHandle handle = OpenParentProcess(System.Diagnostics.Process.GetCurrentProcess().Id);
        bool called = false;
        using (ParentProcessWatchdog watchdog = new ParentProcessWatchdog(
            handle,
            delegate { called = true; }))
        {
            watchdog.Start();
            if (!watchdog.WaitUntilWatchdogEntered())
                throw new InvalidOperationException();
        }
        if (called)
            throw new InvalidOperationException();
    }

    private static void TestInvalidFrameRejection()
    {
        byte[] invalid = new byte[HeaderBytes];
        invalid[0] = Magic0;
        invalid[1] = Magic1;
        invalid[2] = Magic2;
        invalid[3] = Magic3;
        WriteUInt16(invalid, 4, ProtocolVersion);
        WriteUInt16(invalid, 6, 65535);
        bool rejected = false;
        try
        {
            ParentFrameReader reader = new ParentFrameReader(new MemoryStream(invalid, false));
            reader.ReadFrame();
        }
        catch (InvalidDataException)
        {
            rejected = true;
        }
        if (!rejected)
            throw new InvalidOperationException();
    }

    private static void TestRepeatedResourceCleanup()
    {
        int processId = System.Diagnostics.Process.GetCurrentProcess().Id;
        for (int index = 0; index < 64; index += 1)
        {
            using (SecurityDescriptorContext descriptor = CreateSecurityDescriptor())
            {
                SECURITY_ATTRIBUTES attributes = descriptor.Attributes();
                if (attributes.lpSecurityDescriptor == IntPtr.Zero)
                    throw new InvalidOperationException();
            }
            SafeWaitHandle handle = OpenParentProcess(processId);
            using (ParentProcessWatchdog watchdog = new ParentProcessWatchdog(
                handle,
                delegate { throw new InvalidOperationException(); }))
            {
                watchdog.Start();
                if (!watchdog.WaitUntilWatchdogEntered())
                    throw new InvalidOperationException();
            }
        }
    }

    private static void TestPrivatePipeCancellation()
    {
        string endpoint = "\\\\.\\pipe\\tego-self-test-accept-" + Guid.NewGuid().ToString("N");
        using (SecurityDescriptorContext descriptor = CreateSecurityDescriptor())
        using (SafeFileHandle server = CreateVerifiedPipe(endpoint, descriptor, true))
        using (ManualResetEvent cancellation = new ManualResetEvent(false))
        using (ManualResetEvent armed = new ManualResetEvent(false))
        {
            bool connected = true;
            bool failed = false;
            Thread acceptThread = new Thread(delegate()
            {
                try
                {
                    connected = WaitForConnection(server, armed, cancellation);
                }
                catch
                {
                    failed = true;
                }
            });
            acceptThread.IsBackground = true;
            acceptThread.Name = "tego-broker-self-test-accept-cancel";
            acceptThread.Start();
            if (!armed.WaitOne(OperationTimeoutMilliseconds))
                FailFastResource();
            cancellation.Set();
            if (!acceptThread.Join(ShutdownTimeoutMilliseconds))
                FailFastResource();
            if (connected || failed)
                throw new InvalidOperationException();
        }

        using (SelfTestPipePair pair = CreateConnectedSelfTestPipe())
        {
            TestPendingReadCancellation(pair.Server);
        }
        using (SelfTestPipePair pair = CreateConnectedSelfTestPipe())
        {
            TestPendingWriteCancellation(pair.Server);
        }
    }

    private static void TestWritePreIssueCancellation()
    {
        using (SelfTestPipePair pair = CreateConnectedSelfTestPipe())
        using (ManualResetEvent shutdown = new ManualResetEvent(false))
        using (ManualResetEvent writePublished = new ManualResetEvent(false))
        using (ManualResetEvent writeContinue = new ManualResetEvent(false))
        using (ManualResetEvent writeCancellationObserved = new ManualResetEvent(false))
        {
            PipeConnection connection = new PipeConnection(
                null,
                pair.Server,
                1,
                shutdown,
                writePublished,
                writeContinue,
                writeCancellationObserved);
            bool writeResult = true;
            bool writeFailed = false;
            bool disposeFailed = false;
            Thread writeThread = new Thread(delegate()
            {
                try
                {
                    writeResult = connection.Write(new byte[MaxFrameBytes]);
                }
                catch
                {
                    writeFailed = true;
                }
            });
            Thread disposeThread = new Thread(delegate()
            {
                try
                {
                    connection.Dispose();
                }
                catch
                {
                    disposeFailed = true;
                }
            });
            writeThread.IsBackground = true;
            disposeThread.IsBackground = true;
            writeThread.Name = "tego-broker-self-test-pre-issue-write";
            disposeThread.Name = "tego-broker-self-test-pre-issue-dispose";
            writeThread.Start();
            if (!writePublished.WaitOne(OperationTimeoutMilliseconds))
                FailFastResource();
            disposeThread.Start();
            if (!writeCancellationObserved.WaitOne(OperationTimeoutMilliseconds))
                FailFastResource();
            writeContinue.Set();
            if (!writeThread.Join(ShutdownTimeoutMilliseconds) ||
                !disposeThread.Join(ShutdownTimeoutMilliseconds))
                FailFastResource();
            if (writeResult || writeFailed || disposeFailed)
                throw new InvalidOperationException();
        }
    }

    private static void TestPendingCloseAdmission()
    {
        PendingCloseTracker tracker = new PendingCloseTracker();
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(ShutdownTimeoutMilliseconds);
        int id;
        for (id = 1; id <= MaxConnections; id += 1)
            tracker.AddBrokerFirst((ulong)id, deadline);
        if (tracker.Count != MaxConnections || tracker.CanAdmit(0))
            throw new InvalidOperationException();

        tracker.AcknowledgeParent(1);
        if (!tracker.CanAdmit(0))
            throw new InvalidOperationException();
        tracker.AddBrokerFirst((ulong)(MaxConnections + 1), deadline);
        for (id = 2; id <= 10000; id += 1)
        {
            tracker.AcknowledgeParent((ulong)id);
            tracker.AddBrokerFirst((ulong)(id + MaxConnections), deadline);
            if (tracker.Count != MaxConnections)
                throw new InvalidOperationException();
        }
        if (tracker.CanAdmit(0) || tracker.HasExpired(deadline.AddMilliseconds(-1)))
            throw new InvalidOperationException();
        tracker.Clear();
        if (tracker.Count != 0 || !tracker.CanAdmit(0))
            throw new InvalidOperationException();
    }

    private static void TestPauseImmediateResume()
    {
        using (SelfTestPipePair pair = CreateConnectedSelfTestPipe())
        using (ManualResetEvent shutdown = new ManualResetEvent(false))
        using (ManualResetEvent pauseGate = new ManualResetEvent(true))
        {
            byte[] firstBuffer = new byte[1];
            using (OverlappedOperation operation = new OverlappedOperation(
                pair.Server,
                firstBuffer,
                shutdown))
            {
                PendingReadOperation pendingRead = new PendingReadOperation(1, operation);
                int error;
                bool synchronous = operation.IssueRead(1, out error);
                if (synchronous || error != ErrorIoPending)
                    throw new InvalidOperationException();
                pauseGate.Reset();
                pendingRead.Cancel(ReadCancellationReason.Pause);
                pauseGate.Set();
                uint transferred;
                bool completed = operation.Complete(OperationTimeoutMilliseconds, out transferred);
                bool resumed = pauseGate.WaitOne(0);
                if (completed || operation.ErrorCode != ErrorOperationAborted || !resumed ||
                    !ShouldRetryCanceledRead(operation.ErrorCode, pendingRead, false, false))
                    throw new InvalidOperationException();
            }

            WriteSelfTestPayload(pair.Client, new byte[] { 42 });
            byte[] resumedBuffer = new byte[1];
            using (OverlappedOperation resumedRead = new OverlappedOperation(
                pair.Server,
                resumedBuffer,
                shutdown))
            {
                int error;
                bool synchronous = resumedRead.IssueRead(1, out error);
                if (!synchronous && error != ErrorIoPending)
                    throw new InvalidOperationException();
                uint transferred;
                if (!resumedRead.Complete(OperationTimeoutMilliseconds, out transferred) ||
                    transferred != 1 || resumedBuffer[0] != 42)
                    throw new InvalidOperationException();
            }
        }
    }

    private static void TestRepeatedPipeCleanup()
    {
        for (int index = 0; index < 16; index += 1)
        {
            SelfTestPipePair pair = CreateConnectedSelfTestPipe();
            try
            {
                TestPendingReadDispose(pair.Server);
            }
            finally
            {
                pair.Dispose();
                pair.Dispose();
            }
        }
    }

    private static void TestPendingReadDispose(SafeFileHandle server)
    {
        using (ManualResetEvent shutdown = new ManualResetEvent(false))
        {
            OverlappedOperation operation = new OverlappedOperation(server, new byte[1], shutdown);
            int error;
            bool synchronous = operation.IssueRead(1, out error);
            if (synchronous || error != ErrorIoPending)
            {
                operation.Dispose();
                throw new InvalidOperationException();
            }
            operation.Dispose();
            operation.Dispose();
        }
    }

    private static SelfTestPipePair CreateConnectedSelfTestPipe()
    {
        string endpoint = "\\\\.\\pipe\\tego-self-test-pair-" + Guid.NewGuid().ToString("N");
        SafeFileHandle server = null;
        SafeFileHandle client = null;
        ManualResetEvent cancellation = new ManualResetEvent(false);
        ManualResetEvent armed = new ManualResetEvent(false);
        Thread acceptThread = null;
        bool connected = false;
        bool failed = false;
        try
        {
            using (SecurityDescriptorContext descriptor = CreateSecurityDescriptor())
            {
                server = CreateVerifiedPipe(endpoint, descriptor, true);
            }
            SafeFileHandle acceptServer = server;
            acceptThread = new Thread(delegate()
            {
                try
                {
                    connected = WaitForConnection(acceptServer, armed, cancellation);
                }
                catch
                {
                    failed = true;
                }
            });
            acceptThread.IsBackground = true;
            acceptThread.Name = "tego-broker-self-test-connect";
            acceptThread.Start();
            if (!armed.WaitOne(OperationTimeoutMilliseconds))
                FailFastResource();
            client = CreateFileW(
                endpoint,
                GenericRead | GenericWrite,
                0,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOverlapped,
                IntPtr.Zero);
            if (client == null || client.IsInvalid)
                throw new InvalidOperationException();
            if (!acceptThread.Join(ShutdownTimeoutMilliseconds))
            {
                cancellation.Set();
                if (!acceptThread.Join(ShutdownTimeoutMilliseconds))
                    FailFastResource();
            }
            if (!connected || failed)
                throw new InvalidOperationException();
            SelfTestPipePair pair = new SelfTestPipePair(server, client);
            server = null;
            client = null;
            return pair;
        }
        finally
        {
            cancellation.Set();
            if (acceptThread != null && acceptThread.IsAlive &&
                !acceptThread.Join(ShutdownTimeoutMilliseconds))
                FailFastResource();
            armed.Dispose();
            cancellation.Dispose();
            if (client != null)
                client.Dispose();
            if (server != null)
                server.Dispose();
        }
    }

    private static void TestPendingReadCancellation(SafeFileHandle server)
    {
        using (ManualResetEvent shutdown = new ManualResetEvent(false))
        using (OverlappedOperation operation = new OverlappedOperation(
            server,
            new byte[1],
            shutdown))
        {
            int error;
            bool synchronous = operation.IssueRead(1, out error);
            if (synchronous || error != ErrorIoPending)
                throw new InvalidOperationException();
            operation.RequestCancellation();
            uint transferred;
            if (operation.Complete(OperationTimeoutMilliseconds, out transferred) ||
                operation.ErrorCode != ErrorOperationAborted)
                throw new InvalidOperationException();
        }
    }

    private static void TestPendingWriteCancellation(SafeFileHandle server)
    {
        using (ManualResetEvent shutdown = new ManualResetEvent(false))
        {
            byte[] payload = new byte[MaxFrameBytes];
            for (int attempt = 0; attempt < 8; attempt += 1)
            {
                using (OverlappedOperation operation = new OverlappedOperation(server, payload, shutdown))
                {
                    int error;
                    bool synchronous = operation.IssueWrite((uint)payload.Length, out error);
                    if (!synchronous && error == ErrorIoPending)
                    {
                        operation.RequestCancellation();
                        uint canceledBytes;
                        if (operation.Complete(OperationTimeoutMilliseconds, out canceledBytes) ||
                            operation.ErrorCode != ErrorOperationAborted)
                            throw new InvalidOperationException();
                        return;
                    }
                    if (!synchronous)
                        throw new InvalidOperationException();
                    uint transferred;
                    if (!operation.Complete(OperationTimeoutMilliseconds, out transferred) ||
                        transferred != payload.Length)
                        throw new InvalidOperationException();
                }
            }
            throw new InvalidOperationException();
        }
    }

    private static void WriteSelfTestPayload(SafeFileHandle client, byte[] payload)
    {
        using (ManualResetEvent shutdown = new ManualResetEvent(false))
        using (OverlappedOperation operation = new OverlappedOperation(client, payload, shutdown))
        {
            int error;
            bool synchronous = operation.IssueWrite((uint)payload.Length, out error);
            if (!synchronous && error != ErrorIoPending)
                throw new InvalidOperationException();
            uint transferred;
            if (!operation.Complete(OperationTimeoutMilliseconds, out transferred) ||
                transferred != payload.Length)
                throw new InvalidOperationException();
        }
    }
}

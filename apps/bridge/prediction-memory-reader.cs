using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public sealed class PredictionMemoryException : Exception
{
    public PredictionMemoryException(string message) : base(message) { }
}

public sealed class PredictionMemoryKey
{
    public string address;
    public string name;
}

public sealed class PredictionMemoryKeysResult
{
    public readonly List<PredictionMemoryKey> keys = new List<PredictionMemoryKey>();
    public bool truncated;
}

public sealed class PredictionMemoryReferenceTarget
{
    public string cage;
    public uint value;
}

public sealed class PredictionMemoryReference
{
    public string address;
    public uint value;
    public string cage;
}

public sealed class PredictionMemoryReferencesResult
{
    public readonly List<PredictionMemoryReference> matches = new List<PredictionMemoryReference>();
    public bool truncated;
}

// 仅通过父进程私有标准流工作，不创建端口、管道、文件转储或目标进程内的执行入口。
public sealed class PredictionMemoryReader : IDisposable
{
    const ulong CageSize = 0x100000000UL;
    const ulong AddressLimit = 0x0000800000000000UL;
    const int ChunkSize = 65536;
    const int ReferenceLimit = 2048;
    const long EpochTicks = 621355968000000000L;
    static readonly string[] AllowedNames = { "cumberbatchController", "queries", "sourceTurnId", "queryKey" };
    static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    [StructLayout(LayoutKind.Sequential)]
    struct Region
    {
        public ulong Address, AllocationBase;
        public uint AllocationProtect, Partition;
        public ulong Size;
        public uint State, Protect, Type, Padding;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern UIntPtr VirtualQueryEx(IntPtr handle, IntPtr address, out Region region, UIntPtr size);
    [DllImport("kernel32.dll")]
    static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref int size);

    readonly int processId;
    readonly long startedAtMs;
    readonly long creationFileTime;
    readonly HashSet<ulong> cages = new HashSet<ulong>();
    IntPtr handle;

    // 预算同时计入扫描和对象验证读取，失败的读取也计费，避免保护变化导致无限重试。
    sealed class Budget
    {
        readonly Stopwatch clock = Stopwatch.StartNew();
        long bytes;
        public bool Truncated;

        public bool Check()
        {
            if (clock.ElapsedMilliseconds >= 15000) Truncated = true;
            return !Truncated;
        }

        public bool Spend(int count)
        {
            if (!Check()) return false;
            if (count > 512L * 1024 * 1024 - bytes)
            {
                Truncated = true;
                return false;
            }
            bytes += count;
            return true;
        }
    }

    public PredictionMemoryReader(int pid, long expectedStartedAtMs)
    {
        if (IntPtr.Size != 8 || pid <= 0 || expectedStartedAtMs <= 0)
            throw new PredictionMemoryException("进程参数无效");
        processId = pid;
        startedAtMs = expectedStartedAtMs;
        handle = OpenProcess(0x1010, false, pid);
        if (handle == IntPtr.Zero) throw new PredictionMemoryException("无法只读访问目标进程");
        try
        {
            long exited, kernel, user;
            if (!GetProcessTimes(handle, out creationFileTime, out exited, out kernel, out user))
                throw new PredictionMemoryException("目标进程身份校验失败");
            var path = new StringBuilder(32768);
            int size = path.Capacity;
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps");
            string pattern = "^" + Regex.Escape(root) + @"\\OpenAI\.Codex_[^\\]+__2p2nqsd0c76g0\\app\\(?:ChatGPT|Codex)\.exe$";
            if (!QueryFullProcessImageName(handle, 0, path, ref size) ||
                !Regex.IsMatch(path.ToString(), pattern, RegexOptions.IgnoreCase))
                throw new PredictionMemoryException("目标进程身份校验失败");
            EnsureSameProcess();
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    // 固定句柄和精确创建时间，PID 退出或复用时拒绝后续操作，永不自动重连。
    void EnsureSameProcess()
    {
        long created, exited, kernel, user;
        uint code;
        if (handle == IntPtr.Zero || !GetExitCodeProcess(handle, out code) || code != 259 ||
            !GetProcessTimes(handle, out created, out exited, out kernel, out user) || created != creationFileTime)
            throw new PredictionMemoryException("目标进程已退出或代次不匹配");
        try
        {
            using (var process = Process.GetProcessById(processId))
            {
                long actual = (process.StartTime.ToUniversalTime().Ticks - EpochTicks) / TimeSpan.TicksPerMillisecond;
                long fromHandle = (DateTime.FromFileTimeUtc(created).Ticks - EpochTicks) / TimeSpan.TicksPerMillisecond;
                if (actual != startedAtMs || fromHandle != startedAtMs)
                    throw new PredictionMemoryException("目标进程已退出或代次不匹配");
            }
        }
        catch (PredictionMemoryException) { throw; }
        catch { throw new PredictionMemoryException("目标进程已退出或代次不匹配"); }
    }

    static ulong Cage(ulong address) { return address & 0xffffffff00000000UL; }
    static string Hex(ulong address) { return "0x" + address.ToString("x", CultureInfo.InvariantCulture); }

    static ulong ParseAddress(string value)
    {
        ulong address;
        if (value == null || !Regex.IsMatch(value, @"^0x[0-9a-fA-F]{1,16}$") ||
            !UInt64.TryParse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out address) ||
            address >= AddressLimit)
            throw new PredictionMemoryException("内存地址无效");
        return address;
    }

    bool Query(ulong address, out Region region)
    {
        return VirtualQueryEx(handle, new IntPtr((long)address), out region,
            (UIntPtr)Marshal.SizeOf(typeof(Region))) != UIntPtr.Zero;
    }

    static bool Readable(Region region)
    {
        if (region.State != 0x1000 || (region.Protect & 0x100) != 0) return false;
        uint protection = region.Protect & 0xff;
        return protection == 0x02 || protection == 0x04 || protection == 0x08 ||
            protection == 0x20 || protection == 0x40 || protection == 0x80;
    }

    static bool Writable(Region region)
    {
        uint protection = region.Protect & 0xff;
        return protection == 0x04 || protection == 0x08 || protection == 0x40 || protection == 0x80;
    }

    // 逐区检查当前保护，允许 V8 Map 所在的只读页，不依赖启动时的页面快照。
    bool RangeReadable(ulong address, int length)
    {
        ulong end = address + (ulong)Math.Max(1, length);
        if (end > AddressLimit) return false;
        while (address < end)
        {
            Region region;
            if (!Query(address, out region) || !Readable(region) || region.Size == 0 ||
                region.Address > address || region.Size > AddressLimit - region.Address) return false;
            ulong next = region.Address + region.Size;
            if (next <= address) return false;
            address = next;
        }
        return true;
    }

    bool TryRead(ulong address, byte[] buffer, int length, Budget budget)
    {
        if (budget != null && !budget.Spend(length)) return false;
        if (!RangeReadable(address, length)) return false;
        if (length == 0) return true;
        UIntPtr read;
        return ReadProcessMemory(handle, new IntPtr((long)address), buffer, (UIntPtr)length, out read) &&
            read.ToUInt64() == (ulong)length;
    }

    // 已匹配的字段名还必须具备 V8 字符串头和 seq-one-byte Map，禁止裸文本误识别登记 cage。
    bool ValidKey(ulong address, byte[] bytes, int index, string name, Budget budget)
    {
        uint map = BitConverter.ToUInt32(bytes, index);
        if ((map & 1) == 0 || BitConverter.ToInt32(bytes, index + 8) != name.Length) return false;
        for (int part = 0; part < name.Length; part++)
            if (bytes[index + 12 + part] != (byte)name[part]) return false;
        var shape = new byte[12];
        try
        {
            ulong mapAddress = Cage(address) + (map & 0xfffffffeU);
            if (!TryRead(mapAddress, shape, shape.Length, budget)) return false;
            ushort type = BitConverter.ToUInt16(shape, 8);
            return type < 128 && (type & 7) == 0 && (type & 8) != 0;
        }
        finally { Array.Clear(shape, 0, shape.Length); }
    }

    // 缓冲区只在本次扫描中复用并最终清零，跨块重读少量尾部以覆盖字符串边界。
    void ScanRange(ulong start, ulong end, bool writableOnly, int overlap, Budget budget,
        Func<ulong, byte[], int, int, bool> visit)
    {
        var buffer = new byte[ChunkSize + overlap];
        try
        {
            ulong cursor = start;
            while (cursor < end && budget.Check())
            {
                Region region;
                if (!Query(cursor, out region)) break;
                if (region.Size == 0 || region.Address > cursor || region.Size > AddressLimit - region.Address) break;
                ulong regionEnd = Math.Min(end, region.Address + region.Size);
                if (regionEnd <= cursor) break;
                if (region.Type != 0x20000 || !Readable(region) || (writableOnly && !Writable(region)))
                {
                    cursor = regionEnd;
                    continue;
                }
                while (cursor < regionEnd && budget.Check())
                {
                    int primary = (int)Math.Min((ulong)ChunkSize, regionEnd - cursor);
                    int length = (int)Math.Min((ulong)(primary + overlap), regionEnd - cursor);
                    if (TryRead(cursor, buffer, length, budget) && !visit(cursor, buffer, length, primary)) return;
                    cursor += (ulong)primary;
                }
            }
        }
        finally { Array.Clear(buffer, 0, buffer.Length); }
    }

    public PredictionMemoryKeysResult FindKeys(string[] names)
    {
        EnsureSameProcess();
        if (names == null || names.Length == 0 || names.Length > AllowedNames.Length)
            throw new PredictionMemoryException("字段名不在白名单内");
        var requested = new HashSet<string>(StringComparer.Ordinal);
        int longest = 0;
        foreach (string name in names)
        {
            if (Array.IndexOf(AllowedNames, name) < 0) throw new PredictionMemoryException("字段名不在白名单内");
            requested.Add(name);
            longest = Math.Max(longest, name.Length);
        }
        var result = new PredictionMemoryKeysResult();
        var budget = new Budget();
        ScanRange(0, AddressLimit, true, 12 + longest - 1, budget, delegate(ulong address, byte[] bytes, int length, int primary)
        {
            for (int index = 0; index < primary && index + 12 <= length; index += 4)
            {
                if ((index & 4095) == 0 && !budget.Check()) return false;
                int size = BitConverter.ToInt32(bytes, index + 8);
                if (size <= 0 || size > longest || index + 12 + size > length) continue;
                foreach (string name in requested)
                {
                    if (size != name.Length || !ValidKey(address + (ulong)index, bytes, index, name, budget)) continue;
                    ulong found = address + (ulong)index;
                    cages.Add(Cage(found));
                    result.keys.Add(new PredictionMemoryKey { address = Hex(found), name = name });
                }
            }
            return true;
        });
        EnsureSameProcess();
        result.truncated = budget.Truncated;
        return result;
    }

    public PredictionMemoryReferencesResult References(PredictionMemoryReferenceTarget[] targets)
    {
        EnsureSameProcess();
        if (targets == null || targets.Length == 0) throw new PredictionMemoryException("引用目标无效");
        var byCage = new SortedDictionary<ulong, HashSet<uint>>();
        foreach (PredictionMemoryReferenceTarget target in targets)
        {
            if (target == null) throw new PredictionMemoryException("引用目标无效");
            ulong cage = ParseAddress(target.cage);
            if (Cage(cage) != cage || !cages.Contains(cage)) throw new PredictionMemoryException("内存范围尚未登记");
            HashSet<uint> values;
            if (!byCage.TryGetValue(cage, out values))
            {
                values = new HashSet<uint>();
                byCage.Add(cage, values);
            }
            values.Add(target.value);
        }
        var result = new PredictionMemoryReferencesResult();
        var budget = new Budget();
        foreach (KeyValuePair<ulong, HashSet<uint>> entry in byCage)
        {
            ulong cage = entry.Key;
            ScanRange(cage, cage + CageSize, false, 0, budget, delegate(ulong address, byte[] bytes, int length, int primary)
            {
                for (int index = 0; index + 4 <= length; index += 4)
                {
                    if ((index & 4095) == 0 && !budget.Check()) return false;
                    uint value = BitConverter.ToUInt32(bytes, index);
                    if (!entry.Value.Contains(value)) continue;
                    result.matches.Add(new PredictionMemoryReference { address = Hex(address + (ulong)index), value = value, cage = Hex(cage) });
                    if (result.matches.Count == ReferenceLimit)
                    {
                        budget.Truncated = true;
                        return false;
                    }
                }
                return true;
            });
            if (!budget.Check()) break;
        }
        EnsureSameProcess();
        result.truncated = budget.Truncated;
        return result;
    }

    public string Read(string addressHex, int length)
    {
        EnsureSameProcess();
        ulong address = ParseAddress(addressHex);
        if (length < 0 || length > 65536) throw new PredictionMemoryException("读取长度超出限制");
        if (!cages.Contains(Cage(address)) || (ulong)length > CageSize - (address - Cage(address)))
            throw new PredictionMemoryException("内存范围尚未登记");
        var bytes = new byte[length];
        try
        {
            if (!TryRead(address, bytes, length, null)) throw new PredictionMemoryException("目标内存当前不可读");
            EnsureSameProcess();
            return Convert.ToBase64String(bytes);
        }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    // 按 UTF-8 字节限制单行，超限立即终止读取，由宿主关闭进程，避免无换行输入无限分配。
    public static string ReadRequestLine(Stream input)
    {
        var bytes = new byte[8192];
        int count = 0;
        try
        {
            int next;
            while ((next = input.ReadByte()) != -1 && next != 10)
            {
                if (count == bytes.Length) throw new PredictionMemoryException("请求行超过限制");
                bytes[count++] = (byte)next;
            }
            if (next == -1 && count == 0) return null;
            if (count > 0 && bytes[count - 1] == 13) count--;
            try { return StrictUtf8.GetString(bytes, 0, count); }
            catch { throw new PredictionMemoryException("请求编码无效"); }
        }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    public void Dispose()
    {
        cages.Clear();
        if (handle == IntPtr.Zero) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}

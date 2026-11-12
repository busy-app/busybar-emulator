// jobrun.exe <program> [arguments...]: runs a program inside a job object that kills every process in it when the
// job closes, as the sandbox of an agent may (EMU-157). This program puts itself in the job first, so the program and
// everything it starts belong to it; when this program ends, the job closes and takes them all.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

static class JobRun
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static int Main(string[] args)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        ExtendedLimits limits = new ExtendedLimits();
        limits.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (job == IntPtr.Zero || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) || !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
        {
            Console.Error.WriteLine("jobrun: could not make the job object: " + Marshal.GetLastWin32Error());
            return 99;
        }
        ProcessStartInfo start = new ProcessStartInfo(args[0], Rest(Environment.CommandLine, 2));
        start.UseShellExecute = false;
        using (Process child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // The command line from its n-th word on, as given (simple words: this is a test's tool).
    static string Rest(string commandLine, int skip)
    {
        int i = 0;
        for (int word = 0; word < skip; word++)
        {
            while (i < commandLine.Length && commandLine[i] == ' ') i++;
            bool quoted = false;
            while (i < commandLine.Length && (quoted || commandLine[i] != ' '))
            {
                if (commandLine[i] == '"') quoted = !quoted;
                i++;
            }
        }
        return commandLine.Substring(i);
    }
}

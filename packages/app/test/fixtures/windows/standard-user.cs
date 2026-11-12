// For the tests of setup.exe: runs a command line with the rights of a standard user, whoever starts this. The token
// is the caller's own, cut down by Windows the way it cuts down an administrator's under UAC (the "normal user" level
// of the Software Restriction Policies API: no Administrators group, no administrator privileges) and set to medium
// integrity. No account is made and no setting is changed. The exit code is the child's; 740 means Windows refused to
// start the program without elevation (ERROR_ELEVATION_REQUIRED).
//   standard-user.exe "<program>" <arguments...>
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

internal static class StandardUser
{
    private const uint SAFER_SCOPEID_USER = 2;
    private const uint SAFER_LEVELID_NORMALUSER = 0x20000;
    private const uint SAFER_LEVEL_OPEN = 1;
    private const int TokenIntegrityLevel = 25;
    private const uint SE_GROUP_INTEGRITY = 0x20;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SaferCreateLevel(uint scope, uint level, uint flags, out IntPtr handle, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr inToken, out IntPtr outToken, uint flags, IntPtr reserved);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SaferCloseLevel(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int infoClass, ref TOKEN_MANDATORY_LABEL info, int length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr token, string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string folder, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Rest(string line)
    {
        string rest = line.TrimStart();
        if (rest.StartsWith("\""))
        {
            int end = rest.IndexOf('"', 1);
            return end < 0 ? "" : rest.Substring(end + 1).TrimStart();
        }
        int space = rest.IndexOfAny(new char[] { ' ', '\t' });
        return space < 0 ? "" : rest.Substring(space).TrimStart();
    }

    private static int Main()
    {
        string commandLine = Rest(Environment.CommandLine);
        if (commandLine.Length == 0)
        {
            Console.Error.WriteLine("usage: standard-user.exe \"<program>\" <arguments...>");
            return 2;
        }
        IntPtr level, token, sid;
        if (!SaferCreateLevel(SAFER_SCOPEID_USER, SAFER_LEVELID_NORMALUSER, SAFER_LEVEL_OPEN, out level, IntPtr.Zero)) throw new Win32Exception();
        if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero)) throw new Win32Exception();
        SaferCloseLevel(level);
        if (!ConvertStringSidToSid("S-1-16-8192", out sid)) throw new Win32Exception();
        TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
        label.Label.Sid = sid;
        label.Label.Attributes = SE_GROUP_INTEGRITY;
        if (!SetTokenInformation(token, TokenIntegrityLevel, ref label, Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)))) throw new Win32Exception();
        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION info;
        if (!CreateProcessAsUser(token, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref startup, out info))
        {
            int error = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("could not start " + commandLine + ": " + new Win32Exception(error).Message + " (" + error + ")");
            return error == 740 ? 740 : 1;
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(info.hProcess, out code);
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
        CloseHandle(token);
        return (int)code;
    }
}

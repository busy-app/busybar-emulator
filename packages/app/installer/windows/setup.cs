// The setup of BUSY Bar Emulator for Windows (EMU-203, ADR-0002 section 3): it installs the app for the current user,
// without administrator rights, into %LOCALAPPDATA%\Programs\BUSY Bar Emulator, puts a shortcut in the user's
// Start menu and an entry in Settings -> Apps, and writes the uninstaller (uninstall.cs: this same program without
// the app) into the folder. The app folder is a zip appended to this program, followed by a trailer: the zip's
// SHA-256 (32 bytes), its length (8 bytes, little-endian) and the marker of SetupInfo.Magic (8 bytes).
//
//   setup.exe [/S] [/NoShortcut] [/LOG=<file>] [/D=<folder>]
//   setup.exe /Uninstall [/S] [/KeepData | /RemoveData] [/LOG=<file>] [/D=<folder>]     (uninstall.cs)
//
//   /S            silent: no question and no window; the result is the exit code and the log
//   /NoShortcut   no Start menu shortcut and no entry in Settings -> Apps (an install that is not the user's own:
//                 tests, a second copy)
//   /LOG=<file>   where the log goes, added to the file; by default %TEMP%\busybar-emulator-setup.log
//   /D=<folder>   where the app goes; last on the line, the rest of the line is the folder, quotes optional (a
//                 switch after it is refused)
//
// It replaces only a folder it made itself (busybar-emulator-install.json inside), an empty one or a link; any other
// folder is refused and left as it is.
//
// Exit codes: 0 installed, 1 failed (also: no right to change the folder), 2 wrong arguments or a folder that is not
// the setup's, 3 the app is running from the folder (or a file in it is open), 4 the user said no. Written for the C#
// compiler of .NET Framework 4 that is part of Windows (C# 5).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

// The path rules of .NET Framework 4.6.2 and later: without this the compiler's default makes the runtime keep the old
// rules, which refuse any path over 260 characters, and the app has deeper paths than that once it lies in a folder
// with a long name (npm's own files are 114 characters below the resources folder).
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.6.2")]

internal sealed class SetupError : Exception
{
    public readonly int Code;
    public SetupError(int code, string message) : base(message) { Code = code; }
}

/// <summary>A read-only view of part of a file: the zip inside this program.</summary>
internal sealed class PartStream : Stream
{
    private readonly Stream inner;
    private readonly long start;
    private readonly long length;
    private long position;

    public PartStream(Stream inner, long start, long length)
    {
        this.inner = inner;
        this.start = start;
        this.length = length;
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position
    {
        get { return position; }
        set { Seek(value, SeekOrigin.Begin); }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        long left = length - position;
        if (left <= 0) return 0;
        if (count > left) count = (int)left;
        inner.Position = start + position;
        int n = inner.Read(buffer, offset, count);
        position += n;
        return n;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long to = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? position + offset : length + offset;
        if (to < 0 || to > length) throw new IOException("Seek outside the payload");
        position = to;
        return position;
    }

    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

internal static class Setup
{
    internal const string AppName = "BUSY Bar Emulator";
    internal const string ExeName = "BUSY Bar Emulator.exe";
    private static StreamWriter log;

    /// <summary>A full path in the form Windows takes past 260 characters.</summary>
    internal static string Long(string path)
    {
        return path.StartsWith(@"\\?\") ? path : @"\\?\" + path;
    }

    internal static void Log(string line)
    {
        if (log == null) return;
        try
        {
            log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line);
            log.Flush();
        }
        catch (IOException) { }
    }

    internal sealed class Options
    {
        public bool Silent;
        public bool NoShortcut;
        public bool Uninstall;
        public bool KeepData;
        public bool RemoveData;
        public string LogFile;
        public string Folder;
    }

    /// <summary>
    /// The arguments as the line has them: /D= takes the rest of the line, so a folder with spaces needs no quotes, as
    /// with NSIS. The program's own name is cut by the rule Windows uses for it.
    /// </summary>
    internal static Options Parse(string line)
    {
        string rest = line.TrimStart();
        if (rest.StartsWith("\""))
        {
            int end = rest.IndexOf('"', 1);
            rest = end < 0 ? "" : rest.Substring(end + 1);
        }
        else
        {
            int end = rest.IndexOfAny(new char[] { ' ', '\t' });
            rest = end < 0 ? "" : rest.Substring(end);
        }
        Options o = new Options();
        while (true)
        {
            rest = rest.TrimStart();
            if (rest.Length == 0) break;
            if (rest.StartsWith("/D=", StringComparison.OrdinalIgnoreCase))
            {
                string folder = rest.Substring(3).Trim();
                if (folder.Length >= 2 && folder.StartsWith("\"") && folder.EndsWith("\"")) folder = folder.Substring(1, folder.Length - 2);
                if (folder.Length == 0) throw new SetupError(2, "/D= names no folder.");
                CheckNoSwitches(folder);
                o.Folder = folder;
                break;
            }
            string word;
            if (rest.StartsWith("\""))
            {
                int end = rest.IndexOf('"', 1);
                if (end < 0) throw new SetupError(2, "An argument has no closing quote.");
                word = rest.Substring(1, end - 1);
                rest = rest.Substring(end + 1);
            }
            else
            {
                int end = rest.IndexOfAny(new char[] { ' ', '\t' });
                word = end < 0 ? rest : rest.Substring(0, end);
                rest = end < 0 ? "" : rest.Substring(end);
            }
            if (word.StartsWith("/D=", StringComparison.OrdinalIgnoreCase))
            {
                // Quoted as a whole ("/D=C:\a b"), as programs that quote every argument with a space write it.
                if (word.Length == 3) throw new SetupError(2, "/D= names no folder.");
                o.Folder = word.Substring(3);
                CheckNoSwitches(o.Folder);
            }
            else if (string.Equals(word, "/S", StringComparison.OrdinalIgnoreCase)) o.Silent = true;
            else if (string.Equals(word, "/NoShortcut", StringComparison.OrdinalIgnoreCase)) o.NoShortcut = true;
            else if (string.Equals(word, "/Uninstall", StringComparison.OrdinalIgnoreCase)) o.Uninstall = true;
            else if (string.Equals(word, "/KeepData", StringComparison.OrdinalIgnoreCase)) o.KeepData = true;
            else if (string.Equals(word, "/RemoveData", StringComparison.OrdinalIgnoreCase)) o.RemoveData = true;
            else if (word.StartsWith("/LOG=", StringComparison.OrdinalIgnoreCase) && word.Length > 5) o.LogFile = word.Substring(5);
            else throw new SetupError(2, "Unknown argument: " + word + ". " + Usage);
        }
        return o;
    }

    private const string Usage = "The setup takes /S, /NoShortcut, /LOG=<file> and /D=<folder> (last); the uninstaller takes /S, /KeepData or /RemoveData, /LOG=<file> and /D=<folder> (last).";

    /// <summary>The arguments that belong to the other of the two, the setup and the uninstaller, are refused.</summary>
    internal static void CheckMode(Options o, bool uninstall)
    {
        if (uninstall && o.NoShortcut) throw new SetupError(2, "/NoShortcut is the setup's, not the uninstaller's. " + Usage);
        if (!uninstall && (o.KeepData || o.RemoveData)) throw new SetupError(2, (o.KeepData ? "/KeepData" : "/RemoveData") + " is the uninstaller's, not the setup's: the setup never touches the data folder. " + Usage);
        if (o.KeepData && o.RemoveData) throw new SetupError(2, "/KeepData and /RemoveData cannot both be given.");
    }

    /// <summary>
    /// /D= takes the rest of the line, so a switch written after it would become part of the folder and, /S lost, the
    /// setup would ask its questions to an agent that cannot answer. Such a line is refused.
    /// </summary>
    private static void CheckNoSwitches(string folder)
    {
        foreach (string word in folder.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string w = word.Trim('"');
            bool known = false;
            foreach (string name in new string[] { "/S", "/NoShortcut", "/Uninstall", "/KeepData", "/RemoveData" }) known = known || string.Equals(w, name, StringComparison.OrdinalIgnoreCase);
            if (known || w.StartsWith("/LOG=", StringComparison.OrdinalIgnoreCase) || w.StartsWith("/D=", StringComparison.OrdinalIgnoreCase))
            {
                throw new SetupError(2, "/D= must be the last argument: the rest of the line is the folder, and it holds " + w + ".");
            }
        }
    }

    internal static string DefaultFolder()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(Path.Combine(local, "Programs"), AppName);
    }

    internal static string CheckFolder(string folder)
    {
        if (!Path.IsPathRooted(folder) || folder.StartsWith("\\\\")) throw new SetupError(2, "The folder must be a full path on a drive of this computer: " + folder);
        string full = Path.GetFullPath(folder).TrimEnd('\\');
        if (Path.GetPathRoot(full).TrimEnd('\\') == full) throw new SetupError(2, "The app is not installed into the root of a drive: " + folder);
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\');
        if (full.Equals(windows, StringComparison.OrdinalIgnoreCase) || full.StartsWith(windows + "\\", StringComparison.OrdinalIgnoreCase)) throw new SetupError(2, "The app is not installed into the Windows folder: " + folder);
        return full;
    }

    /// <summary>Whether this program ends with an app (the setup) or not (the uninstaller the setup wrote).</summary>
    internal static bool HasPayload(string self)
    {
        using (FileStream stream = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
        {
            if (stream.Length < SetupInfo.TrailerBytes) return false;
            byte[] magic = new byte[8];
            stream.Position = stream.Length - 8;
            ReadAll(stream, magic);
            return System.Text.Encoding.ASCII.GetString(magic) == SetupInfo.Magic;
        }
    }

    /// <summary>The payload of this program: offset and length, checked against the SHA-256 in the trailer.</summary>
    private static void FindPayload(FileStream self, out long offset, out long length)
    {
        long size = self.Length;
        if (size < SetupInfo.TrailerBytes) throw new SetupError(1, "The setup file is damaged. Download it again and check it against SHA256SUMS.");
        byte[] trailer = new byte[SetupInfo.TrailerBytes];
        self.Position = size - SetupInfo.TrailerBytes;
        ReadAll(self, trailer);
        string magic = System.Text.Encoding.ASCII.GetString(trailer, 40, 8);
        if (magic != SetupInfo.Magic) throw new SetupError(1, "The setup file is damaged: it holds no app. Download it again and check it against SHA256SUMS.");
        length = BitConverter.ToInt64(trailer, 32);
        offset = size - SetupInfo.TrailerBytes - length;
        if (length <= 0 || offset <= 0) throw new SetupError(1, "The setup file is damaged. Download it again and check it against SHA256SUMS.");
        byte[] actual;
        using (SHA256 sha = SHA256.Create())
        {
            actual = sha.ComputeHash(new PartStream(self, offset, length));
        }
        for (int i = 0; i < 32; i++)
        {
            if (actual[i] != trailer[i]) throw new SetupError(1, "The setup file is damaged: the app inside it does not match its checksum. Download it again and check it against SHA256SUMS.");
        }
    }

    private static void ReadAll(Stream s, byte[] buffer)
    {
        int done = 0;
        while (done < buffer.Length)
        {
            int n = s.Read(buffer, done, buffer.Length - done);
            if (n == 0) throw new SetupError(1, "The setup file is damaged. Download it again and check it against SHA256SUMS.");
            done += n;
        }
    }

    /// <summary>Unpacks the app; gives the bytes of its files.</summary>
    private static long Extract(FileStream self, long offset, long length, string to, Action<int, int> progress)
    {
        long bytes = 0;
        using (ZipArchive zip = new ZipArchive(new PartStream(self, offset, length), ZipArchiveMode.Read, true))
        {
            string root = Path.GetFullPath(to).TrimEnd('\\') + "\\";
            int count = zip.Entries.Count;
            int done = 0;
            byte[] buffer = new byte[1 << 20];
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string name = entry.FullName.Replace('/', '\\');
                string target = Path.GetFullPath(Path.Combine(root, name));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase) || name.EndsWith("\\")) throw new SetupError(1, "The setup file is damaged: an entry would go outside the app's folder: " + entry.FullName);
                Directory.CreateDirectory(Long(Path.GetDirectoryName(target)));
                using (Stream input = entry.Open())
                using (FileStream output = new FileStream(Long(target), FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    int n;
                    while ((n = input.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, n);
                }
                bytes += entry.Length;
                done++;
                if (progress != null) progress(done, count);
            }
        }
        return bytes;
    }

    /// <summary>
    /// The uninstaller of an install is this program without the app at its end (uninstall.cs): the first `stubLength`
    /// bytes, written into the folder as uninstall.exe.
    /// </summary>
    private static void WriteUninstaller(FileStream self, long stubLength, string folder)
    {
        byte[] buffer = new byte[1 << 16];
        using (FileStream output = new FileStream(Long(Path.Combine(folder, Uninstall.FileName)), FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            long left = stubLength;
            self.Position = 0;
            while (left > 0)
            {
                int n = self.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                if (n == 0) throw new SetupError(1, "The setup file is damaged. Download it again and check it against SHA256SUMS.");
                output.Write(buffer, 0, n);
                left -= n;
            }
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool RemoveDirectoryW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeleteFileW(string path);

    /// <summary>
    /// Removes a folder and what is in it. A link inside (a junction, a symbolic link) is removed as a link: what it
    /// points to is never entered, never changed. (Directory.Delete of .NET Framework refuses a tree with a junction in
    /// it under a \\?\ path, and left the folder behind; EMU-203 security review, S4.)
    /// </summary>
    internal static void RemoveTree(string path)
    {
        string p = Long(path);
        FileAttributes attributes = File.GetAttributes(p);
        if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(p, attributes & ~FileAttributes.ReadOnly);
        bool folder = (attributes & FileAttributes.Directory) != 0;
        if (folder && (attributes & FileAttributes.ReparsePoint) == 0)
        {
            foreach (string entry in Directory.GetFileSystemEntries(p)) RemoveTree(entry);
        }
        bool removed = folder ? RemoveDirectoryW(p) : DeleteFileW(p);
        if (!removed) throw new IOException("could not remove " + path + ": " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
    }

    private static void RemoveQuietly(string folder)
    {
        try
        {
            if (Directory.Exists(Long(folder))) RemoveTree(folder);
        }
        catch (Exception e)
        {
            Log("could not remove " + folder + ": " + e.Message);
        }
    }

    /// <summary>
    /// The file the setup writes into every folder it makes, and the only proof it takes that a folder is its own: a
    /// folder is replaced, and a leftover removed, only when it holds this file. A folder of the user's is never taken
    /// for an install by its name or by what lies in it.
    /// </summary>
    internal const string MarkerName = "busybar-emulator-install.json";
    private const string MarkerText = "{\"app\":\"app.busy.emulator\",\"by\":\"setup\"}";

    internal static bool IsLink(string folder)
    {
        return (File.GetAttributes(Long(folder)) & FileAttributes.ReparsePoint) != 0;
    }

    internal static bool HasMarker(string folder)
    {
        string marker = Long(Path.Combine(folder, MarkerName));
        if (!File.Exists(marker)) return false;
        try
        {
            return File.ReadAllText(marker).Trim().StartsWith(MarkerText.Substring(0, MarkerText.Length - 1));
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static void WriteMarker(string folder)
    {
        Directory.CreateDirectory(Long(folder));
        File.WriteAllText(Long(Path.Combine(folder, MarkerName)), MarkerText.Substring(0, MarkerText.Length - 1) + ",\"version\":\"" + SetupInfo.Version + "\"}\r\n");
    }

    /// <summary>
    /// What an earlier setup left when it was stopped half-way: "name.new-pid" and "name.old-pid" beside the app's
    /// folder, a number after the dash, real folders, with the setup's marker inside. Anything else of that name is not
    /// the setup's and stays.
    /// </summary>
    private static void RemoveLeftovers(string folder)
    {
        string parent = Path.GetDirectoryName(folder);
        if (!Directory.Exists(Long(parent))) return;
        string name = Path.GetFileName(folder);
        foreach (string pattern in new string[] { name + ".new-*", name + ".old-*" })
        {
            foreach (string left in Directory.GetDirectories(parent, pattern))
            {
                string suffix = Path.GetFileName(left).Substring(name.Length + 5);
                bool number = suffix.Length > 0 && suffix.Length <= 10;
                foreach (char c in suffix) if (c < '0' || c > '9') number = false;
                if (number && !IsLink(left) && HasMarker(left)) RemoveQuietly(left);
                else Log("left alone, not the setup's own: " + left);
            }
        }
    }

    /// <summary>
    /// Whether the folder may be replaced: it is not there, it is empty, it is a link (only the link goes, never what it
    /// points to), or it is an install the setup made. A folder that holds anything else is refused, with nothing touched.
    /// </summary>
    internal static void CheckReplaceable(string folder)
    {
        if (!Directory.Exists(Long(folder)))
        {
            if (File.Exists(Long(folder))) throw new SetupError(2, folder + " is a file, not a folder. Name a new or empty folder for the app.");
            return;
        }
        if (IsLink(folder)) return;
        if (Directory.GetFileSystemEntries(Long(folder)).Length == 0) return;
        if (HasMarker(folder)) return;
        throw new SetupError(2, folder + " holds files that are not an install of " + AppName + ", and the setup does not replace them. Name a new or empty folder, or the folder the app was installed into.");
    }

    private const FileSystemRights Writes = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes
        | FileSystemRights.WriteAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
        | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership | (FileSystemRights)0x10000000 /* GENERIC_ALL */ | (FileSystemRights)0x40000000 /* GENERIC_WRITE */;

    private static bool Trusted(SecurityIdentifier sid, SecurityIdentifier me)
    {
        return sid.Equals(me)
            || sid.IsWellKnown(WellKnownSidType.LocalSystemSid)
            || sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)
            // On a parent, it stands for whoever makes the child: this user.
            || sid.IsWellKnown(WellKnownSidType.CreatorOwnerSid)
            // NT SERVICE\TrustedInstaller
            || sid.Value == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    }

    private static string NameOf(SecurityIdentifier sid)
    {
        try
        {
            return sid.Translate(typeof(NTAccount)).Value;
        }
        catch (Exception)
        {
            return sid.Value;
        }
    }

    /// <summary>
    /// The app's folder must be changeable by this user (and the system and administrators) alone: whoever else may
    /// write in it could change the app's files, and their code would run as this user (EMU-203 security review, S1).
    /// The folder's own rights are read, or, where it is not there yet, the rights it would take over from the nearest
    /// folder above it. Such a folder is refused, nothing is made.
    /// </summary>
    internal static void CheckOnlyUserCanChange(string folder)
    {
        string at = folder;
        bool notThereYet = false;
        while (!Directory.Exists(Long(at)))
        {
            string up = Path.GetDirectoryName(at);
            if (up == null) return;
            at = up;
            notThereYet = true;
        }
        SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
        AuthorizationRuleCollection rules = new DirectoryInfo(Long(at)).GetAccessControl(AccessControlSections.Access).GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in rules)
        {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            // A right of the folder above that its new folders do not take over.
            if (notThereYet && rule.InheritanceFlags == InheritanceFlags.None) continue;
            if ((rule.FileSystemRights & Writes) == 0) continue;
            SecurityIdentifier sid = (SecurityIdentifier)rule.IdentityReference;
            if (Trusted(sid, me)) continue;
            throw new SetupError(2, folder + " can be changed by others: " + NameOf(sid) + " may write in " + at + ", so another user could change the app's files. Name a folder only you can change, such as the default " + DefaultFolder() + ".");
        }
    }

    /// <summary>A folder the setup cannot change for want of rights, rather than for a file in use.</summary>
    internal static bool CanWriteBeside(string folder)
    {
        string probe = folder + ".probe-" + Process.GetCurrentProcess().Id;
        try
        {
            Directory.CreateDirectory(Long(probe));
            Directory.Delete(Long(probe));
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Puts the new folder in place of the old one, whole or not at all. Gives the bytes of the app's files.</summary>
    internal static long Install(FileStream self, long offset, long length, string folder, Action<int, int> progress)
    {
        long bytes;
        CheckOnlyUserCanChange(folder);
        CheckReplaceable(folder);
        RemoveLeftovers(folder);
        Directory.CreateDirectory(Long(Path.GetDirectoryName(folder)));
        string pid = Process.GetCurrentProcess().Id.ToString();
        string staging = folder + ".new-" + pid;
        string old = folder + ".old-" + pid;
        Log("unpacking into " + staging);
        try
        {
            // The marker first: a staging folder left by a stopped run is recognized as the setup's own.
            WriteMarker(staging);
            bytes = Extract(self, offset, length, staging, progress);
            WriteUninstaller(self, offset, staging);
        }
        catch
        {
            RemoveQuietly(staging);
            throw;
        }
        if (!File.Exists(Long(Path.Combine(staging, ExeName))))
        {
            RemoveQuietly(staging);
            throw new SetupError(1, "The setup file is damaged: it holds no " + ExeName + ".");
        }
        bool hadOld = Directory.Exists(Long(folder));
        if (hadOld && IsLink(folder))
        {
            // A link in the app's place: the link goes, what it points to is not touched.
            try
            {
                if (!RemoveDirectoryW(Long(folder))) throw new IOException(new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
            }
            catch (Exception e)
            {
                RemoveQuietly(staging);
                throw new SetupError(1, "Could not remove the link " + folder + ": " + e.Message);
            }
            Log("removed the link " + folder);
            hadOld = false;
        }
        if (hadOld)
        {
            try
            {
                Directory.Move(Long(folder), Long(old));
            }
            catch (Exception e)
            {
                RemoveQuietly(staging);
                if (!(e is IOException || e is UnauthorizedAccessException)) throw;
                if (!CanWriteBeside(folder)) throw new SetupError(1, "The setup has no right to change " + folder + " (" + e.Message + "). Name a folder of your own.");
                throw new SetupError(3, AppName + " is running from " + folder + ", or a file in it is open (" + e.Message + "). Quit it and run the setup again.");
            }
        }
        try
        {
            Directory.Move(Long(staging), Long(folder));
        }
        catch
        {
            if (hadOld) Directory.Move(Long(old), Long(folder));
            RemoveQuietly(staging);
            throw;
        }
        if (hadOld) RemoveQuietly(old);
        return bytes;
    }

    /// <summary>The user's Start menu shortcut, made through the shell's own scripting object.</summary>
    internal static string MakeShortcut(string folder)
    {
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        string link = Path.Combine(programs, AppName + ".lnk");
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        if (type == null) throw new SetupError(1, "Windows has no WScript.Shell to make the Start menu shortcut with.");
        object shell = Activator.CreateInstance(type);
        object shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
        Type s = shortcut.GetType();
        s.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(folder, ExeName) });
        s.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { folder });
        s.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { AppName });
        s.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        return link;
    }

    private static bool Elevated()
    {
        try
        {
            return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private sealed class ProgressWindow : Form
    {
        private readonly ProgressBar bar = new ProgressBar();
        private readonly Label label = new Label();
        public Exception Failure;
        private readonly Action<Action<int, int>> work;

        public ProgressWindow(string text, Action<Action<int, int>> work)
        {
            this.work = work;
            Text = AppName + " setup";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ControlBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new System.Drawing.Size(420, 90);
            label.SetBounds(16, 14, 388, 20);
            label.Text = text;
            bar.SetBounds(16, 44, 388, 22);
            Controls.Add(label);
            Controls.Add(bar);
            Shown += delegate
            {
                Thread thread = new Thread(Run);
                thread.IsBackground = true;
                thread.Start();
            };
        }

        private void Run()
        {
            try
            {
                work(delegate (int done, int count)
                {
                    if (done % 25 != 0 && done != count) return;
                    BeginInvoke((Action)delegate { bar.Maximum = count; bar.Value = done; });
                });
            }
            catch (Exception e)
            {
                Failure = e;
            }
            BeginInvoke((Action)Close);
        }
    }

    private static void OpenLog(string file)
    {
        try
        {
            // Appended, never overwritten: /LOG= may name a file that is not the setup's.
            log = new StreamWriter(file, true, new System.Text.UTF8Encoding(false));
        }
        catch (Exception)
        {
            log = null;
        }
    }

    private const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetDefaultDllDirectories(uint directoryFlags);

    [STAThread]
    private static int Main()
    {
        // First: DLLs that Windows or the runtime look up by name from now on come from System32 only, never from the
        // folder setup.exe was downloaded to (EMU-203 security review, S2). What the runtime loads before Main runs is
        // out of this line's reach; the program itself imports nothing.
        bool system32Only = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        Options options = null;
        try
        {
            options = Parse(Environment.CommandLine);
        }
        catch (SetupError e)
        {
            OpenLog(Path.Combine(Path.GetTempPath(), "busybar-emulator-setup.log"));
            Log("error " + e.Code + ": " + e.Message + " (the command line: " + Environment.CommandLine + ")");
            if (log != null) log.Dispose();
            if (!System.Text.RegularExpressions.Regex.IsMatch(Environment.CommandLine, @"(^|\s)/S(\s|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            {
                MessageBox.Show(e.Message, AppName + " setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return e.Code;
        }
        string logFile = options.LogFile ?? Path.Combine(Path.GetTempPath(), "busybar-emulator-setup.log");
        OpenLog(logFile);
        string self = Assembly.GetExecutingAssembly().Location;
        // This program with an app at its end is the setup; without one it is the uninstaller the setup wrote.
        bool hasPayload = true;
        try
        {
            hasPayload = HasPayload(self);
        }
        catch (Exception) { }
        bool uninstall = options.Uninstall || !hasPayload;
        string title = AppName + (uninstall ? " uninstaller" : " setup");
        Log(title + " " + SetupInfo.Version + (options.Silent ? ", silent" : "") + ", administrator: " + (Elevated() ? "yes" : "no") + ", DLLs from System32 only: " + (system32Only ? "yes" : "no"));
        try
        {
            CheckMode(options, uninstall);
            if (uninstall) return Uninstall.Run(options, hasPayload, logFile, CloseLog);
            string folder = CheckFolder(options.Folder ?? DefaultFolder());
            Log("folder: " + folder);
            long bytes = 0;
            using (FileStream stream = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                long offset, length;
                FindPayload(stream, out offset, out length);
                if (!options.Silent)
                {
                    DialogResult answer = MessageBox.Show(
                        "Install " + AppName + " " + SetupInfo.Version + " for " + Environment.UserName + "?\n\nIt goes to " + folder + ". No administrator rights are needed.",
                        AppName + " setup", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                    if (answer != DialogResult.OK)
                    {
                        Log("the user said no");
                        return 4;
                    }
                    ProgressWindow window = new ProgressWindow("Installing " + AppName + "...", delegate (Action<int, int> progress) { bytes = Install(stream, offset, length, folder, progress); });
                    Application.EnableVisualStyles();
                    Application.Run(window);
                    if (window.Failure != null) throw window.Failure;
                }
                else
                {
                    bytes = Install(stream, offset, length, folder, null);
                }
            }
            Log("installed " + Path.Combine(folder, ExeName));
            if (!options.NoShortcut)
            {
                Log("shortcut: " + MakeShortcut(folder));
                // After the app is in place: an entry in Settings -> Apps without an uninstaller behind it is worse
                // than none.
                Uninstall.Register(folder, bytes);
                Log("entry in Settings -> Apps: HKCU\\" + Uninstall.KeyPath);
            }
            if (!options.Silent)
            {
                DialogResult open = MessageBox.Show(AppName + " is installed. Open it now?", AppName + " setup", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (open == DialogResult.Yes) Process.Start(new ProcessStartInfo(Path.Combine(folder, ExeName)) { UseShellExecute = true, WorkingDirectory = folder });
            }
            return 0;
        }
        catch (Exception e)
        {
            SetupError known = e as SetupError;
            int code = known != null ? known.Code : 1;
            string message = known != null ? known.Message : "The " + (uninstall ? "uninstaller" : "setup") + " failed: " + e.Message + " The log is " + logFile + ".";
            Log("error " + code + ": " + message + (known != null ? "" : "\n" + e));
            if (!options.Silent) MessageBox.Show(message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return code;
        }
        finally
        {
            CloseLog();
            // Last of all: an uninstaller that moved out of the app's folder has its own file deleted after it ends.
            Uninstall.Finish();
        }
    }

    private static void CloseLog()
    {
        if (log == null) return;
        log.Dispose();
        log = null;
    }
}

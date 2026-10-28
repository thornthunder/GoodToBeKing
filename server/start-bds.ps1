# Starts the Bedrock Dedicated Server and gives the named players operator rights each time they
# spawn. The server runs in offline mode, where it cannot keep operator rights on disk (players
# have no account id: "Missing id, won't persist permissions on disk"), so Merlin would lose his
# magic on every reconnect. Everything you type is passed on to the server as usual.
#
# Copy this file and start-bds.cmd next to bedrock_server.exe and start the server with
# start-bds.cmd instead of bedrock_server.exe.
param(
  [string]$Server = (Join-Path $PSScriptRoot 'bedrock_server.exe'),
  [string[]]$Operators = @('Merlin'),
  [string]$Arguments = ''
)

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Threading;

public static class Bds {
  public static int Run(string exe, string arguments, string[] operators) {
    var psi = new ProcessStartInfo(exe, arguments) {
      WorkingDirectory = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(exe)),
      UseShellExecute = false,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
    };
    var server = new Process { StartInfo = psi };
    var gate = new object();
    Action<string> send = line => { lock (gate) { server.StandardInput.WriteLine(line); server.StandardInput.Flush(); } };
    DataReceivedEventHandler show = (s, e) => {
      if (e.Data == null) return;
      Console.WriteLine(e.Data);
      foreach (var name in operators)
        if (e.Data.Contains("Player Spawned: " + name + " xuid")) send("op " + name);
    };
    server.OutputDataReceived += show;
    server.ErrorDataReceived += show;
    server.Start();
    server.BeginOutputReadLine();
    server.BeginErrorReadLine();
    var keyboard = new Thread(() => {
      string line;
      while (!server.HasExited && (line = Console.ReadLine()) != null) send(line);
    }) { IsBackground = true };
    keyboard.Start();
    server.WaitForExit();
    return server.ExitCode;
  }
}
"@

exit [Bds]::Run($Server, $Arguments, $Operators)

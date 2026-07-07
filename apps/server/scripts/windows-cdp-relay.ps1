param(
  [int]$ListenPort,
  [string]$TargetHost = "127.0.0.1",
  [int]$TargetPort
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;

public static class WslCdpRelay
{
    public static void Start(int listenPort, string targetHost, int targetPort)
    {
        var listener = new TcpListener(IPAddress.Any, listenPort);
        listener.Start();
        Console.WriteLine("Relaying 0.0.0.0:" + listenPort + " -> " + targetHost + ":" + targetPort);
        while (true)
        {
            var client = listener.AcceptTcpClient();
            ThreadPool.QueueUserWorkItem(_ => Handle(client, targetHost, targetPort));
        }
    }

    private static void Handle(TcpClient client, string targetHost, int targetPort)
    {
        TcpClient upstream = null;
        try
        {
            upstream = new TcpClient();
            upstream.Connect(targetHost, targetPort);
            var clientStream = client.GetStream();
            var upstreamStream = upstream.GetStream();
            var left = new Thread(() => Pump(clientStream, upstreamStream, client, upstream));
            var right = new Thread(() => Pump(upstreamStream, clientStream, upstream, client));
            left.IsBackground = true;
            right.IsBackground = true;
            left.Start();
            right.Start();
        }
        catch
        {
            TryClose(client);
            TryClose(upstream);
        }
    }

    private static void Pump(NetworkStream from, NetworkStream to, TcpClient fromClient, TcpClient toClient)
    {
        var buffer = new byte[65536];
        try
        {
            while (true)
            {
                int count = from.Read(buffer, 0, buffer.Length);
                if (count <= 0) break;
                to.Write(buffer, 0, count);
                to.Flush();
            }
        }
        catch
        {
        }
        finally
        {
            TryClose(fromClient);
            TryClose(toClient);
        }
    }

    private static void TryClose(TcpClient client)
    {
        if (client == null) return;
        try { client.Close(); } catch {}
    }
}
"@

[WslCdpRelay]::Start($ListenPort, $TargetHost, $TargetPort)

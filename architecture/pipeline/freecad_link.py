"""Send results to a running FreeCAD (2026-11-12).

The FreeCAD MCP add-on (neka-nat/freecad-mcp, README → Requirements) runs an XML-RPC server inside the FreeCAD window,
on localhost:9875, once **Start RPC Server** is pressed (or **Auto-Start Server** is ticked). This module uses two of
its calls: ping, and execute_code to open the files a request has just built (the .FCStd model, else the .ifc).
Nothing is sent unless FreeCAD answers on that port; generation itself never needs the add-on.

    python freecad_link.py --ping
    python freecad_link.py path/to/model.FCStd [more files]
"""
import json
import os
import sys

HOST = os.environ.get("FREECAD_RPC_HOST", "localhost")
PORT = int(os.environ.get("FREECAD_RPC_PORT", "9875"))


def _proxy(timeout=3.0):
    import socket
    import xmlrpc.client

    class T(xmlrpc.client.Transport):
        def make_connection(self, host):
            c = super().make_connection(host)
            c.timeout = timeout
            return c

    socket.setdefaulttimeout(timeout)
    return xmlrpc.client.ServerProxy(f"http://{HOST}:{PORT}", allow_none=True, transport=T())


def ping():
    """True when the FreeCAD MCP add-on's RPC server answers."""
    try:
        return bool(_proxy(1.5).ping())
    except Exception:
        return False


def open_files(paths, close_same=True):
    """Open each file in the running FreeCAD and fit the view. A document of the same name that is already open is
    closed first, so a regenerated building replaces its earlier version. -> (ok, message)."""
    paths = [os.path.abspath(p) for p in paths if p and os.path.exists(p)]
    if not paths:
        return False, "nothing to open"
    if not ping():
        return False, f"FreeCAD is not answering on {HOST}:{PORT} (start the MCP add-on's RPC server)"
    code = f"""
import os, FreeCAD, FreeCADGui
for p in {json.dumps(paths)}:
    name = os.path.splitext(os.path.basename(p))[0].replace('-', '_').replace('.', '_')
    if {close_same!r}:
        for d in list(FreeCAD.listDocuments().values()):
            if os.path.abspath(d.FileName or '') == p or d.Name == name:
                FreeCAD.closeDocument(d.Name)
    FreeCADGui.open(p)
try:
    FreeCADGui.activeDocument().activeView().viewIsometric()
    FreeCADGui.SendMsgToActiveView('ViewFit')
except Exception:
    pass
"""
    try:
        r = _proxy(120.0).execute_code(code)
    except Exception as e:
        return False, f"FreeCAD refused the request: {e}"
    ok = bool(r.get("success", True)) if isinstance(r, dict) else True
    msg = (r.get("message") or r.get("error") or "") if isinstance(r, dict) else str(r)
    return ok, ("opened " + ", ".join(os.path.basename(p) for p in paths)) if ok else msg


if __name__ == "__main__":
    if sys.argv[1:] == ["--ping"]:
        print("FreeCAD RPC server:", "answering" if ping() else "not answering", f"({HOST}:{PORT})")
        sys.exit(0)
    ok, msg = open_files(sys.argv[1:])
    print(msg)
    sys.exit(0 if ok else 1)

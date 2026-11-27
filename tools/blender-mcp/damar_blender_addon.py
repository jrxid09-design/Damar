# Damar Blender Addon — jembatan MCP Produktivitas Damar.
#
# Membuka server socket JSON di 127.0.0.1:9876 di dalam Blender dan
# melayani perintah TERTULIS (typed) dari server MCP "blender" Damar
# (src/mcp/productivity/servers/blender.js). TIDAK ada eksekusi kode
# arbitrer: hanya perintah dalam daftar COMMANDS di bawah.
#
# Protokol (satu JSON per baris):
#   -> {"type": "<perintah>", "params": {...}}
#   <- {"status": "ok", "result": {...}}
#   <- {"status": "error", "message": "..."}
#
# Pasang: Blender → Edit → Preferences → Add-ons → Install… → pilih
# berkas ini → aktifkan "Damar MCP Bridge". Panel: View3D → Sidebar
# (N) → tab "Damar". Server mulai otomatis saat addon diaktifkan.

bl_info = {
    "name": "Damar MCP Bridge",
    "author": "Damar",
    "version": (1, 0, 0),
    "blender": (3, 0, 0),
    "location": "View3D > Sidebar > Damar",
    "description": "Jembatan socket typed-command untuk MCP Produktivitas Damar",
    "category": "Interface",
}

import json
import socket
import threading

import bpy

HOST = "127.0.0.1"
PORT = 9876

_server_socket = None
_server_thread = None
_running = False


# ------------------------------------------------------------------
# Perintah tertulis (typed). Setiap fungsi menerima params dict dan
# mengembalikan dict hasil yang dapat di-JSON-kan.
# ------------------------------------------------------------------

def _vec(v):
    return [round(float(x), 6) for x in v]


def cmd_get_scene_info(params):
    scene = bpy.context.scene
    return {
        "scene": scene.name,
        "objects": len(bpy.data.objects),
        "camera": scene.camera.name if scene.camera else None,
        "render_engine": scene.render.engine,
        "frame_current": scene.frame_current,
        "frame_start": scene.frame_start,
        "frame_end": scene.frame_end,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
    }


def cmd_list_objects(params):
    return {
        "objects": [
            {"name": obj.name, "type": obj.type}
            for obj in bpy.data.objects
        ]
    }


def _find_object(name):
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise ValueError("objek tidak ditemukan: %s" % name)
    return obj


def cmd_get_object_info(params):
    obj = _find_object(params.get("name", ""))
    return {
        "name": obj.name,
        "type": obj.type,
        "location": _vec(obj.location),
        "rotation_euler": _vec(obj.rotation_euler),
        "scale": _vec(obj.scale),
        "visible": obj.visible_get(),
    }


def cmd_set_object_transform(params):
    obj = _find_object(params.get("name", ""))
    if params.get("location") is not None:
        obj.location = params["location"]
    if params.get("rotation") is not None:
        obj.rotation_euler = params["rotation"]
    if params.get("scale") is not None:
        obj.scale = params["scale"]
    bpy.context.view_layer.update()
    return cmd_get_object_info({"name": obj.name})


def cmd_render_image(params):
    filepath = params.get("filepath")
    if not filepath:
        raise ValueError("filepath wajib diisi")
    scene = bpy.context.scene
    old_path = scene.render.filepath
    old_format = scene.render.image_settings.file_format
    try:
        scene.render.filepath = filepath
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
    finally:
        scene.render.filepath = old_path
        scene.render.image_settings.file_format = old_format
    return {"rendered": True, "filepath": filepath}


COMMANDS = {
    "get_scene_info": cmd_get_scene_info,
    "list_objects": cmd_list_objects,
    "get_object_info": cmd_get_object_info,
    "set_object_transform": cmd_set_object_transform,
    "render_image": cmd_render_image,
}


def execute_command(msg):
    """Jalankan satu pesan protokol; kembalikan dict respons."""
    try:
        ctype = msg.get("type")
        handler = COMMANDS.get(ctype)
        if handler is None:
            return {"status": "error", "message": "perintah tidak dikenal: %s" % ctype}
        result = handler(msg.get("params") or {})
        return {"status": "ok", "result": result}
    except Exception as exc:  # permukaan addon: semua error jadi respons
        return {"status": "error", "message": str(exc)}


# ------------------------------------------------------------------
# Server socket (thread latar; perintah dijalankan di thread utama
# Blender lewat timer agar akses bpy aman).
# ------------------------------------------------------------------

def _handle_client(conn):
    buffer = ""
    with conn:
        while True:
            data = conn.recv(65536)
            if not data:
                return
            buffer += data.decode("utf-8", "replace")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    response = {"status": "error", "message": "JSON tidak sah"}
                    conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
                    continue
                # bpy hanya aman di thread utama: antrekan lewat timer.
                done = threading.Event()
                holder = {}

                def _run(msg=msg, holder=holder, done=done):
                    holder["response"] = execute_command(msg)
                    done.set()
                    return None

                bpy.app.timers.register(_run, first_interval=0.0)
                if not done.wait(timeout=120):
                    holder["response"] = {"status": "error", "message": "timeout thread utama Blender"}
                conn.sendall((json.dumps(holder["response"]) + "\n").encode("utf-8"))


def _serve():
    global _server_socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(8)
    sock.settimeout(1.0)
    _server_socket = sock
    while _running:
        try:
            conn, _addr = sock.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=_handle_client, args=(conn,), daemon=True).start()
    try:
        sock.close()
    except OSError:
        pass


def start_server():
    global _server_thread, _running
    if _running:
        return
    _running = True
    _server_thread = threading.Thread(target=_serve, daemon=True)
    _server_thread.start()


def stop_server():
    global _running
    _running = False


class DAMAR_OT_bridge_toggle(bpy.types.Operator):
    bl_idname = "damar.bridge_toggle"
    bl_label = "Mulai/Stop Damar Bridge"

    def execute(self, context):
        if _running:
            stop_server()
            self.report({"INFO"}, "Damar Bridge berhenti")
        else:
            start_server()
            self.report({"INFO"}, "Damar Bridge jalan di %s:%d" % (HOST, PORT))
        return {"FINISHED"}


class DAMAR_PT_bridge_panel(bpy.types.Panel):
    bl_label = "Damar MCP Bridge"
    bl_idname = "DAMAR_PT_bridge_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Damar"

    def draw(self, context):
        layout = self.layout
        layout.label(text="Socket: %s:%d" % (HOST, PORT))
        layout.label(text="Status: %s" % ("jalan" if _running else "berhenti"))
        layout.operator("damar.bridge_toggle", text="Stop" if _running else "Mulai")


CLASSES = (DAMAR_OT_bridge_toggle, DAMAR_PT_bridge_panel)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    start_server()


def unregister():
    stop_server()
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()

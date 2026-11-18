# SPDX-License-Identifier: GPL-3.0-or-later
# NonZeroScript - Godot 4.7.2 editor plugin entry point.
#
# Install at res://addons/nonzeroscript/plugin.gd (the standard plugin spot).
# Every script and data file is loaded RELATIVE to this file's own folder, so
# the plugin also keeps working when it lands somewhere else (for example when
# the addons folder is nested twice as res://addons/addons/nonzeroscript) -
# a hardcoded res://addons/nonzeroscript/... path is what used to fail there
# with "this script may contain code errors" and disable the plugin.

@tool
extends EditorPlugin

# Untyped on purpose: these hold script instances whose custom properties
# (controller_url, on_status, allow_write…) are not members of Node/Control,
# and GDScript statically rejects unknown members on a typed base class.
var _bridge = null
var _commands = null
var _dock = null


func _addon_dir() -> String:
	var script := get_script() as Script
	if script == null or script.resource_path.is_empty():
		return "res://addons/nonzeroscript"
	return script.resource_path.get_base_dir()


func _enter_tree() -> void:
	var dir := _addon_dir()
	var commands_script: Script = load(dir.path_join("core/commands.gd"))
	var bridge_script: Script = load(dir.path_join("core/bridge.gd"))
	var dock_script: Script = load(dir.path_join("ui/dock.gd"))
	if commands_script == null or bridge_script == null or dock_script == null:
		push_error("[NonZeroScript] plugin files not found under %s - " % dir +
			"the addon folder must keep its plugin.gd / core / ui layout.")
		return

	_commands = commands_script.new()
	_commands.editor = self

	_bridge = bridge_script.new()
	_bridge.name = "NonZeroScriptBridge"
	_bridge.commands = _commands
	add_child(_bridge)

	_dock = dock_script.new()
	_dock.name = "NonZeroScript"
	_dock.bridge = _bridge
	_dock.commands = _commands
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)

	if _bridge.has_signal("status_changed"):
		_bridge.status_changed.connect(_dock.on_status)
	if _bridge.has_signal("log_line"):
		_bridge.log_line.connect(_dock.on_log)
	if _bridge.has_signal("chat_event"):
		_bridge.chat_event.connect(_dock.on_chat_event)

	if dir != "res://addons/nonzeroscript":
		print("[NonZeroScript] note: installed at %s - " % dir +
			"the recommended location is res://addons/nonzeroscript/")
	print("[NonZeroScript] plugin loaded - controller: ", _bridge.controller_url)


func _exit_tree() -> void:
	if _dock:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null
	if _bridge:
		_bridge.queue_free()
		_bridge = null
	_commands = null

//! The native macOS menu bar, built from the frontend's command registry
//! (src/shared/commands: a serialized snapshot of ids, labels, accelerators,
//! enabled/checked state and structure). Windows has no native menu: the
//! frontend renders its own themed menu bar there (decision 4ec247fc).
//!
//! Every registry item emits `menu://command` with its id; the frontend runs
//! the command. OS items (Services, Hide, Cut/Copy/Paste/Select All) are
//! predefined items that act on the focused view.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Emitted with the command id when a registry menu item is chosen.
pub const EVENT_COMMAND: &str = "menu://command";

/// Id of the Quit item (also bound before the frontend sent its first snapshot).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const QUIT_ID: &str = "app.quit";

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Node {
    Item {
        id: String,
        label: String,
        #[serde(default)]
        accelerator: Option<String>,
        enabled: bool,
        #[serde(default)]
        checked: Option<bool>,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<Node>,
    },
    Predefined {
        name: String,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TopMenu {
    pub id: String,
    pub label: String,
    pub items: Vec<Node>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Snapshot {
    pub menus: Vec<TopMenu>,
}

/// The snapshot without enabled/checked state: equal shapes are updated in place, not rebuilt.
pub fn shape_key(s: &Snapshot) -> String {
    fn walk(items: &[Node], out: &mut String) {
        for n in items {
            match n {
                Node::Item { id, label, accelerator, checked, .. } => {
                    out.push_str(&format!("i:{id}|{label}|{accelerator:?}|{}\n", checked.is_some()))
                }
                Node::Separator => out.push_str("-\n"),
                Node::Submenu { label, items } => {
                    out.push_str(&format!("s:{label}{{\n"));
                    walk(items, out);
                    out.push_str("}\n");
                }
                Node::Predefined { name } => out.push_str(&format!("p:{name}\n")),
            }
        }
    }
    let mut out = String::new();
    for m in &s.menus {
        out.push_str(&format!("m:{}|{}{{\n", m.id, m.label));
        walk(&m.items, &mut out);
        out.push_str("}\n");
    }
    out
}

/// Enabled / checked state of every item, by id.
pub fn item_states(s: &Snapshot) -> Vec<(String, bool, Option<bool>)> {
    fn walk(items: &[Node], out: &mut Vec<(String, bool, Option<bool>)>) {
        for n in items {
            match n {
                Node::Item { id, enabled, checked, .. } => out.push((id.clone(), *enabled, *checked)),
                Node::Submenu { items, .. } => walk(items, out),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for m in &s.menus {
        walk(&m.items, &mut out);
    }
    out
}

/// Built item handles, for in-place enabled/checked updates.
enum Handle<R: Runtime> {
    Plain(MenuItem<R>),
    Check(CheckMenuItem<R>),
}

pub struct MenuState<R: Runtime> {
    shape: Mutex<Option<String>>,
    items: Mutex<HashMap<String, Handle<R>>>,
}

impl<R: Runtime> Default for MenuState<R> {
    fn default() -> Self {
        MenuState { shape: Mutex::new(None), items: Mutex::new(HashMap::new()) }
    }
}

fn predefined<R: Runtime>(app: &AppHandle<R>, name: &str) -> tauri::Result<Option<PredefinedMenuItem<R>>> {
    Ok(Some(match name {
        "services" => PredefinedMenuItem::services(app, None)?,
        "hide" => PredefinedMenuItem::hide(app, None)?,
        "hideOthers" => PredefinedMenuItem::hide_others(app, None)?,
        "showAll" => PredefinedMenuItem::show_all(app, None)?,
        "cut" => PredefinedMenuItem::cut(app, None)?,
        "copy" => PredefinedMenuItem::copy(app, None)?,
        "paste" => PredefinedMenuItem::paste(app, None)?,
        "selectAll" => PredefinedMenuItem::select_all(app, None)?,
        "minimize" => PredefinedMenuItem::minimize(app, None)?,
        // performClose: emits CloseRequested, so the frontend's unsaved-changes guard runs.
        "closeWindow" => PredefinedMenuItem::close_window(app, None)?,
        _ => return Ok(None),
    }))
}

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    nodes: &[Node],
    handles: &mut HashMap<String, Handle<R>>,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    let mut out = Vec::new();
    for n in nodes {
        match n {
            Node::Item { id, label, accelerator, enabled, checked } => {
                // An accelerator the OS cannot parse is dropped, never the item.
                let accel = accelerator.as_deref();
                if let Some(c) = checked {
                    let item = CheckMenuItem::with_id(app, id, label, *enabled, *c, accel)
                        .or_else(|_| CheckMenuItem::with_id(app, id, label, *enabled, *c, None::<&str>))?;
                    out.push(MenuItemKind::Check(item.clone()));
                    handles.insert(id.clone(), Handle::Check(item));
                } else {
                    let item = MenuItem::with_id(app, id, label, *enabled, accel)
                        .or_else(|_| MenuItem::with_id(app, id, label, *enabled, None::<&str>))?;
                    out.push(MenuItemKind::MenuItem(item.clone()));
                    handles.insert(id.clone(), Handle::Plain(item));
                }
            }
            Node::Separator => out.push(MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?)),
            Node::Submenu { label, items } => {
                let children = build_items(app, items, handles)?;
                let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = children.iter().map(|c| c as &dyn tauri::menu::IsMenuItem<R>).collect();
                out.push(MenuItemKind::Submenu(Submenu::with_items(app, label, true, &refs)?));
            }
            Node::Predefined { name } => {
                if let Some(p) = predefined(app, name)? {
                    out.push(MenuItemKind::Predefined(p));
                }
            }
        }
    }
    Ok(out)
}

/// Build the whole menu bar from a snapshot.
fn build<R: Runtime>(app: &AppHandle<R>, s: &Snapshot, handles: &mut HashMap<String, Handle<R>>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for m in &s.menus {
        let children = build_items(app, &m.items, handles)?;
        let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = children.iter().map(|c| c as &dyn tauri::menu::IsMenuItem<R>).collect();
        menu.append(&Submenu::with_items(app, &m.label, true, &refs)?)?;
    }
    Ok(menu)
}

/// The macOS menu before the frontend sent its first snapshot: the app menu with Quit (so the
/// unsaved-changes flow is reachable at once), the OS Edit items and the Window menu.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn initial_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Novel", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Novel",
        true,
        &[
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

/// Set the native menu from the registry snapshot. Same structure as last time: only enabled /
/// checked state is updated in place. A no-op where the app has no native menu (Windows, Linux).
#[tauri::command]
pub fn menu_set<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MenuState<R>>,
    snapshot: Snapshot,
) -> std::result::Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let key = shape_key(&snapshot);
    let mut shape = state.shape.lock().map_err(|e| e.to_string())?;
    let mut items = state.items.lock().map_err(|e| e.to_string())?;
    if shape.as_deref() == Some(key.as_str()) {
        for (id, enabled, checked) in item_states(&snapshot) {
            match items.get(&id) {
                Some(Handle::Plain(i)) => i.set_enabled(enabled).map_err(|e| e.to_string())?,
                Some(Handle::Check(i)) => {
                    i.set_enabled(enabled).map_err(|e| e.to_string())?;
                    if let Some(c) = checked {
                        i.set_checked(c).map_err(|e| e.to_string())?;
                    }
                }
                None => {}
            }
        }
        return Ok(());
    }
    let mut handles = HashMap::new();
    let menu = build(&app, &snapshot, &mut handles).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    *items = handles;
    *shape = Some(key);
    Ok(())
}

/// Route a menu click to the frontend: one event carrying the command id.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Err(e) = app.emit(EVENT_COMMAND, id) {
        eprintln!("failed to emit menu command {id}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNAPSHOT: &str = r#"{"menus":[
        {"id":"app","label":"Novel","items":[{"kind":"predefined","name":"services"},{"kind":"separator"},
            {"kind":"item","id":"app.quit","label":"Quit Novel","accelerator":"CmdOrCtrl+Q","enabled":true}]},
        {"id":"file","label":"File","items":[
            {"kind":"item","id":"file.save","label":"Save","accelerator":"CmdOrCtrl+S","enabled":false},
            {"kind":"submenu","label":"Open Recent","items":[{"kind":"item","id":"file.open_recent.0","label":"Book","enabled":true}]}]},
        {"id":"format","label":"Format","items":[{"kind":"item","id":"toolbar.bold","label":"Bold","accelerator":"CmdOrCtrl+B","enabled":true,"checked":true}]}
    ]}"#;

    #[test]
    fn parses_the_frontend_snapshot() {
        let s: Snapshot = serde_json::from_str(SNAPSHOT).unwrap();
        assert_eq!(s.menus.len(), 3);
        assert_eq!(s.menus[0].items[0], Node::Predefined { name: "services".into() });
        match &s.menus[1].items[1] {
            Node::Submenu { label, items } => {
                assert_eq!(label, "Open Recent");
                assert_eq!(items.len(), 1);
            }
            other => panic!("expected a submenu, got {other:?}"),
        }
    }

    #[test]
    fn state_changes_keep_the_shape_structure_changes_do_not() {
        let a: Snapshot = serde_json::from_str(SNAPSHOT).unwrap();
        let toggled: Snapshot = serde_json::from_str(&SNAPSHOT.replace(r#""enabled":false"#, r#""enabled":true"#).replace(r#""checked":true"#, r#""checked":false"#)).unwrap();
        assert_eq!(shape_key(&a), shape_key(&toggled));
        let relabelled: Snapshot = serde_json::from_str(&SNAPSHOT.replace(r#""label":"Book""#, r#""label":"Other""#)).unwrap();
        assert_ne!(shape_key(&a), shape_key(&relabelled));
    }

    #[test]
    fn parses_the_window_menu_items() {
        let s: Snapshot = serde_json::from_str(
            r#"{"menus":[{"id":"window","label":"Window","items":[{"kind":"predefined","name":"minimize"},{"kind":"separator"},{"kind":"predefined","name":"closeWindow"}]}]}"#,
        )
        .unwrap();
        assert_eq!(s.menus[0].items[2], Node::Predefined { name: "closeWindow".into() });
        assert!(item_states(&s).is_empty());
    }

    #[test]
    fn lists_item_states_recursively() {
        let s: Snapshot = serde_json::from_str(SNAPSHOT).unwrap();
        assert_eq!(
            item_states(&s),
            vec![
                ("app.quit".to_string(), true, None),
                ("file.save".to_string(), false, None),
                ("file.open_recent.0".to_string(), true, None),
                ("toolbar.bold".to_string(), true, Some(true)),
            ]
        );
    }
}

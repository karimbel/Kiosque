// Évite la fenêtre de console supplémentaire sous Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kiosque_lib::run()
}

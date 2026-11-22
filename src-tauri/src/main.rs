// Nubo runs without a console window: Nubo is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nubo_lib::run()
}

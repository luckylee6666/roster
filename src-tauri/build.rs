fn main() {
    println!("cargo:rerun-if-changed=../src");
    tauri_build::build()
}

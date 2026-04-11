fn main() {
    println!("cargo:rerun-if-changed=../../sigil/proto/sigil.proto");
    println!("cargo:rerun-if-changed=../../sigil/proto");

    let protoc = protoc_bin_vendored::protoc_bin_path()
        .expect("failed to locate a vendored protoc binary");
    std::env::set_var("PROTOC", protoc);

    tonic_build::configure()
        .build_server(false)
        .compile_protos(
            &["../../sigil/proto/sigil.proto"],
            &["../../sigil/proto"],
        )
        .expect("failed to compile sigil.proto");
}

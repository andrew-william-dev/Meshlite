fn main() {
    tonic_build::configure()
        .build_server(false)
        .compile_protos(
            &["../../sigil/proto/sigil.proto"],
            &["../../sigil/proto"],
        )
        .expect("failed to compile sigil.proto");
}

# Practice wallet assertion program

The practice wallet loads Lighthouse in LiteSVM so contest transactions execute the same assertion instructions as a live wallet. The coordination program comes separately from the SDK.

The upstream source is [Lighthouse commit 4c579479](https://github.com/Jac0xb/lighthouse/tree/4c579479c98635e419b1b167f08be02a71604a71). Build from its programs/lighthouse directory with Agave 4.1.0 and `cargo-build-sbf -- --locked`. Compress target/deploy/lighthouse.so with `gzip -n -9` and base64-encode the result in the fixture JSON. This lets the single-file wallet service embed the practice fixture. The SHA-256 of the uncompressed practice binary is `11470d051420d858a3cd767354434c828178fe15e24c0782852c8fa9a82a6728`. The upstream MIT license is included.

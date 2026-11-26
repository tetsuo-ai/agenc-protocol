# Practice wallet assertion program

LiteSVM loads the frozen Lighthouse executable so contests exercise the same account assertions available to revision 9 transactions. The marketplace program comes separately from the SDK. Lighthouse is MIT licensed. [Upstream source and program address](https://github.com/Jac0xb/lighthouse)

The public program is `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`. Its loader-owned ProgramData account is `CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c`, deployed at slot 294179293 with no upgrade authority. The fixture contains its executable bytes from offset 45, gzip compressed and base64 encoded for the single-file wallet service.

The SHA-256 of the uncompressed 424248-byte fixture is `a89179ae024ac36aa5fc308251caa84cd0a3390ae66d8523514004a86d5148bb`. Removing trailing zero padding gives the verified Solana executable hash `b70084e0d1de4a551c2bf9740a9b5012600edb98b56fd84065f0e8f47762529a`. [Independent build verification](https://verify.osec.io/status/L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95)

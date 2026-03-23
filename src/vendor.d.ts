declare module "qrcode-terminal" {
  function generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
  export default { generate };
}

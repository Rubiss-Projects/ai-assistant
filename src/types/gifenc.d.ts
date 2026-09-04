declare module "gifenc" {
  type Palette = number[][];

  interface Encoder {
    writeFrame(
      pixels: Uint8Array,
      width: number,
      height: number,
      options: {
        palette: Palette;
        delay?: number;
        repeat?: number;
        dispose?: number;
        transparent?: boolean;
        transparentIndex?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  const gifenc: {
    GIFEncoder(): Encoder;
    quantize(
      rgba: Uint8Array | Uint8ClampedArray,
      maxColors: number,
      options?: { format?: string; oneBitAlpha?: boolean | number },
    ): Palette;
    applyPalette(
      rgba: Uint8Array | Uint8ClampedArray,
      palette: Palette,
      format?: string,
    ): Uint8Array;
  };

  export default gifenc;
}

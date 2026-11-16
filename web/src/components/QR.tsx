import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** QR rendered locally as SVG (no third-party QR service sees the pay link). */
export function QR({ value, size = 200 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b3d2e", light: "#ffffff" } }).then(setSvg);
  }, [value]);
  return <div className="qr" style={{ width: size, height: size }} role="img" aria-label="QR code for this payment link" dangerouslySetInnerHTML={{ __html: svg }} />;
}

import QRCode from "qrcode";
import { useEffect, useState } from "react";

export default function Qr({ value, size = 220 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" }).then(setSrc);
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt="QR code" className="qr" /> : null;
}

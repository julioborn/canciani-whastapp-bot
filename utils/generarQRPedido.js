const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("canvas");

module.exports = async function generarQRPedido({
    pedidoId,
    fecha,
    hora,
    telefono,
}) {
    const size = 400;
    const extraHeight = 120;

    const canvas = createCanvas(size, size + extraHeight);
    const ctx = canvas.getContext("2d");

    // Fondo blanco
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // QR (solo el ID o URL)
    const qrData = `PEDIDO:${pedidoId}`;
    const qrImage = await QRCode.toDataURL(qrData, {
        margin: 1,
        width: size,
    });

    const img = await loadImage(qrImage);
    ctx.drawImage(img, 0, 0, size, size);

    // Texto debajo
    ctx.fillStyle = "#000";
    ctx.font = "bold 22px Arial";
    ctx.textAlign = "center";

    ctx.fillText(fecha, size / 2, size + 35);
    ctx.fillText(`${hora} hs`, size / 2, size + 70);

    ctx.font = "18px Arial";
    ctx.fillText(`📞 ${telefono}`, size / 2, size + 100);

    return canvas.toBuffer("image/png");
};

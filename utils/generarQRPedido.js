const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("canvas");
const path = require("path");

const dayNameES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function formatearFecha(fechaISO) {
    const [y, m, d] = fechaISO.split("-").map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    return `${dayNameES[dt.getDay()]}, ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

module.exports = async function generarQRPedido({ pedidoId, fecha, hora }) {
    // ======================
    // CONFIGURACIÓN
    // ======================
    const width = 600;
    const height = 800;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Fondo blanco
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);

    // ======================
    // LOGO
    // ======================
    const logoPath = path.join(__dirname, "../assets/canciani.jpg");
    const logo = await loadImage(logoPath);

    const logoSize = 140;
    ctx.drawImage(
        logo,
        width / 2 - logoSize / 2,
        30,
        logoSize,
        logoSize
    );

    // ======================
    // QR
    // ======================
    const qrPayload = JSON.stringify({ pedidoId });

    const qrBuffer = await QRCode.toBuffer(qrPayload, {
        errorCorrectionLevel: "H",
        scale: 6,
        margin: 1,
    });

    const qrImage = await loadImage(qrBuffer);

    const qrSize = 360;
    const qrY = 200;

    ctx.drawImage(
        qrImage,
        width / 2 - qrSize / 2,
        qrY,
        qrSize,
        qrSize
    );

    // ======================
    // TEXTO FECHA
    // ======================
    ctx.fillStyle = "#000";
    ctx.font = "bold 28px Sans";
    ctx.textAlign = "center";

    ctx.fillText(
        formatearFecha(fecha),
        width / 2,
        qrY + qrSize + 60
    );

    // ======================
    // TEXTO HORA
    // ======================
    ctx.font = "24px Sans";
    ctx.fillText(
        `${hora} hs`,
        width / 2,
        qrY + qrSize + 100
    );

    return canvas.toBuffer("image/png");
};

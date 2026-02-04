const QRCode = require("qrcode");

module.exports = async function generarQRPedido(data) {
    const payload = JSON.stringify(data);

    const buffer = await QRCode.toBuffer(payload, {
        type: "png",
        errorCorrectionLevel: "H",
        scale: 8,
    });

    return buffer;
};

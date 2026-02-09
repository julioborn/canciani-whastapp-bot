const mongoose = require("mongoose");

const ClienteSchema = new mongoose.Schema(
    {
        telefono: { type: String, required: true, unique: true },
        nombre: { type: String, required: true },
        documento: { type: String, required: true },
        tipoDocumento: { type: String, required: true },
        ultimoRetira: { type: String },
    },
    { timestamps: true }
);

module.exports =
    mongoose.models.Cliente || mongoose.model("Cliente", ClienteSchema);

const { Schema, model } = require("mongoose");

const PedidoDesposteSchema = new Schema(
    {
        telefono: {
            type: String,
            required: true,
        },

        producto: {
            type: String,
            default: "Media res",
        },

        cantidad: {
            type: Number,
            required: true,
            min: 1,
        },

        fecha: {
            type: String, // YYYY-MM-DD
            required: true,
        },

        hora: {
            type: String, // HH:mm
            required: true,
        },

        precioUnitario: {
            type: Number,
            required: true,
        },

        precioTotal: {
            type: Number,
            required: true,
        },

        estado: {
            type: String,
            enum: ["RESERVADO", "CANCELADO", "ENTREGADO"],
            default: "RESERVADO",
        },
    },
    { timestamps: true }
);

// 🔒 Un turno por fecha + hora
PedidoDesposteSchema.index(
    { fecha: 1, hora: 1 },
    { unique: true }
);

module.exports = model("PedidoDesposte", PedidoDesposteSchema);

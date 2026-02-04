const { Schema, model } = require("mongoose");

const PedidoRetiroSchema = new Schema(
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
            type: String,
            default: "12:00",
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
            enum: ["RESERVADO", "ENTREGADO"],
            default: "RESERVADO",
        },
    },
    { timestamps: true }
);

module.exports = model("PedidoRetiro", PedidoRetiroSchema);

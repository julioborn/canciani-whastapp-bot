const { Schema, model } = require("mongoose");

const PedidoSchema = new Schema(
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

        tipoRetiro: {
            type: String,
            enum: ["desposte", "retiro"],
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

/**
 * 🔒 PROTECCIÓN DE TURNOS
 * No permite dos pedidos en la misma fecha + hora
 */
PedidoSchema.index(
    { fecha: 1, hora: 1 },
    {
        unique: true,
        partialFilterExpression: { tipoRetiro: "desposte" },
    }
);

module.exports = model("Pedido", PedidoSchema);

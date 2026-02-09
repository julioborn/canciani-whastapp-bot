const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const PedidoItemSchema = new Schema(
    {
        productoId: { type: Schema.Types.ObjectId, ref: "Producto", required: true },
        nombre: { type: String, required: true },
        cantidad: { type: Number, required: true, min: 1 }, // unidades
        precioKg: { type: Number, required: true, min: 0 },
        requiereTurno: { type: Boolean, default: false },
    },
    { _id: false }
);

const CierreItemSchema = new Schema(
    {
        productoId: { type: Schema.Types.ObjectId, ref: "Producto" },
        nombre: { type: String, required: true },
        kilosReales: { type: Number, required: true, min: 0 },
        precioKg: { type: Number, required: true, min: 0 },
        subtotal: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const PedidoSchema = new Schema(
    {
        telefono: { type: String, required: true },
        nombreCliente: { type: String, required: true },
        retira: {
            nombre: { type: String, required: true },
        },

        fecha: { type: String, required: true }, // YYYY-MM-DD
        hora: { type: String }, // HH:mm si TURNO

        tipoPedido: {
            type: String,
            enum: ["TURNO", "RETIRO_DIA"],
            required: true,
        },

        items: { type: [PedidoItemSchema], required: true },

        estado: {
            type: String,
            enum: ["RESERVADO", "CANCELADO", "ENTREGADO"],
            default: "RESERVADO",
        },

        cierre: {
            items: { type: [CierreItemSchema], default: undefined },
            precioFinal: { type: Number, default: undefined },
            fechaEntrega: { type: Date, default: undefined },
        },
    },
    { timestamps: true }
);

// 🔒 Un turno por fecha+hora SOLO si tipoPedido=TURNO
PedidoSchema.index(
    { fecha: 1, hora: 1 },
    {
        unique: true,
        partialFilterExpression: { tipoPedido: "TURNO" },
    }
);

module.exports = model("Pedido", PedidoSchema);
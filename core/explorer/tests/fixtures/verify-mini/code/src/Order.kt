class Order(val id: Long)

class OrderService(private val stock: StockService) {
    fun place(order: Order) {
        stock.reserve(order.id)
        publish("shop/order/placed")
    }
}

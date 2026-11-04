class StockService(private val repo: StockRepository) {
    fun reserve(id: Long) {
        // the stock of the order
        repo.decrement(id)
    }
}

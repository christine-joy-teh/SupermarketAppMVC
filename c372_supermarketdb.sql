CREATE DATABASE  IF NOT EXISTS `c372_supermarketdb` /*!40100 DEFAULT CHARACTER SET latin1 */ /*!80016 DEFAULT ENCRYPTION='N' */;
USE `c372_supermarketdb`;
-- MySQL dump 10.13  Distrib 8.0.34, for Win64 (x86_64)
--
-- Host: localhost    Database: c372_supermarketdb
-- ------------------------------------------------------
-- Server version	8.2.0

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `productName` varchar(200) COLLATE utf8mb4_general_ci NOT NULL,
  `quantity` int NOT NULL,
  `price` double(10,2) NOT NULL,
  `image` varchar(50) COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=21 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `products`
--

LOCK TABLES `products` WRITE;
/*!40000 ALTER TABLE `products` DISABLE KEYS */;
INSERT INTO `products` VALUES (1,'Apples',50,1.50,'apples.png'),(2,'Bananas',75,0.80,'bananas.png'),(3,'Milk',50,3.50,'milk.png'),(4,'Bread',80,1.80,'bread.png'),(14,'Tomatoes',80,1.50,'tomatoes.png'),(19,'Broccoli',100,5.00,'Broccoli.png');
/*!40000 ALTER TABLE `products` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(20) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `address` varchar(255) NOT NULL,
  `contact` varchar(10) NOT NULL,
  `role` varchar(10) NOT NULL,
  `loyalty_points` int NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'Peter Lim','peter@peter.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands Ave 2','98765432','admin',0),(2,'Mary Tan','mary@mary.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Tampines Ave 1','12345678','user',0),(3,'bobochan','bobochan@gmail.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands','98765432','user',0),(4,'sarahlee','sarahlee@gmail.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands','98765432','user',0);
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2025-10-19 17:33:08

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  userId INT NULL,
  user_id INT NULL,
  subtotal DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) DEFAULT 0,
  savings DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'processing',
  itemsJson LONGTEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deliveryMethod VARCHAR(50) DEFAULT 'delivery',
  deliveryAddress VARCHAR(255) DEFAULT NULL,
  pickupOutlet VARCHAR(255) DEFAULT NULL,
  paymentMethod VARCHAR(50) DEFAULT NULL,
  paymentRef VARCHAR(255) DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS user_carts (
  userId INT NOT NULL PRIMARY KEY,
  items LONGTEXT NOT NULL,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  orderId INT NOT NULL,
  userId INT NOT NULL,
  reason TEXT NOT NULL,
  documentPath VARCHAR(255) DEFAULT NULL,
  total_amount DECIMAL(10,2) DEFAULT 0,
  destination VARCHAR(30) DEFAULT 'E_WALLET',
  status VARCHAR(20) DEFAULT 'pending',
  adminNote TEXT DEFAULT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NULL,
  name VARCHAR(255) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  qty INT NOT NULL,
  line_total DECIMAL(10,2) NOT NULL,
  refunded_qty INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refund_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  refund_id INT NOT NULL,
  order_item_id INT NOT NULL,
  refund_qty INT NOT NULL,
  refund_amount DECIMAL(10,2) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transaction_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  action_type VARCHAR(20) NOT NULL,
  previous_balance DECIMAL(10,2) DEFAULT NULL,
  new_balance DECIMAL(10,2) DEFAULT NULL,
  reference_id INT DEFAULT NULL,
  suspicious_flag TINYINT(1) NOT NULL DEFAULT 0,
  suspicious_reason VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

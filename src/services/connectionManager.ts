
import type { Connection } from "@hocuspocus/server";
import { getLogger } from "./logging.ts";

let logger: ReturnType<typeof getLogger> | null = null;
function getManagerLogger() {
  if (!logger) {
    logger = getLogger(["connection-manager"]);
  }
  return logger;
}

class ConnectionManager {
  private connections: Map<string, Set<Connection>> = new Map();

  addConnection(userId: string, connection: Connection) {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(connection);
    getManagerLogger().info(`Connection added for user ${userId}. Total connections for user: ${this.connections.get(userId)!.size}`);
  }

  removeConnection(userId: string, connection: Connection) {
    const userConnections = this.connections.get(userId);
    if (userConnections) {
      userConnections.delete(connection);
      if (userConnections.size === 0) {
        this.connections.delete(userId);
      }
      getManagerLogger().info(`Connection removed for user ${userId}. Remaining connections: ${userConnections.size}`);
    }
  }

  getConnections(userId: string): Set<Connection> | undefined {
    return this.connections.get(userId);
  }

  sendMessage(userId: string, payload: any) {
    const connections = this.getConnections(userId);
    if (connections && connections.size > 0) {
      const message = JSON.stringify(payload);
      getManagerLogger().info(`Sending message to user ${userId}`, { payload });
      for (const connection of connections) {
        connection.sendStateless(message);
      }
    } else {
      getManagerLogger().warn(`No active connections found for user ${userId} to send message.`);
    }
  }
}

export const connectionManager = new ConnectionManager();

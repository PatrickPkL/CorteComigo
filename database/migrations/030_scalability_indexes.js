exports.up = async function(knex) {
  // Appointments indexes
  await knex.schema.alterTable('appointments', (table) => {
    table.index(['professional_id', 'scheduled_at'], 'idx_appointments_professional_scheduled');
    table.index(['client_id', 'scheduled_at'], 'idx_appointments_client_scheduled');
    table.index(['status', 'scheduled_at'], 'idx_appointments_status_scheduled');
    table.index(['business_id', 'scheduled_at'], 'idx_appointments_business_scheduled');
    table.index(['service_id', 'scheduled_at'], 'idx_appointments_service_scheduled');
  });

  // Services indexes
  await knex.schema.alterTable('services', (table) => {
    table.index(['business_id', 'is_active'], 'idx_services_business_active');
    table.index(['category_id', 'is_active'], 'idx_services_category_active');
    table.index(['professional_id', 'is_active'], 'idx_services_professional_active');
  });

  // Professionals indexes
  await knex.schema.alterTable('professionals', (table) => {
    table.index(['business_id', 'is_active'], 'idx_professionals_business_active');
    table.index(['user_id'], 'idx_professionals_user');
    table.index(['specialty_id', 'is_active'], 'idx_professionals_specialty_active');
  });

  // Reviews indexes
  await knex.schema.alterTable('reviews', (table) => {
    table.index(['business_id', 'created_at'], 'idx_reviews_business_created');
    table.index(['professional_id', 'created_at'], 'idx_reviews_professional_created');
    table.index(['client_id', 'created_at'], 'idx_reviews_client_created');
    table.index(['rating'], 'idx_reviews_rating');
  });

  // Payments indexes
  await knex.schema.alterTable('payments', (table) => {
    table.index(['appointment_id'], 'idx_payments_appointment');
    table.index(['client_id', 'created_at'], 'idx_payments_client_created');
    table.index(['business_id', 'created_at'], 'idx_payments_business_created');
    table.index(['status', 'created_at'], 'idx_payments_status_created');
    table.index(['payment_method', 'created_at'], 'idx_payments_method_created');
  });

  // Users indexes
  await knex.schema.alterTable('users', (table) => {
    table.index(['email'], 'idx_users_email');
    table.index(['phone'], 'idx_users_phone');
    table.index(['business_id', 'role'], 'idx_users_business_role');
    table.index(['is_active', 'created_at'], 'idx_users_active_created');
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('appointments', (table) => {
    table.dropIndex('idx_appointments_professional_scheduled');
    table.dropIndex('idx_appointments_client_scheduled');
    table.dropIndex('idx_appointments_status_scheduled');
    table.dropIndex('idx_appointments_business_scheduled');
    table.dropIndex('idx_appointments_service_scheduled');
  });

  await knex.schema.alterTable('services', (table) => {
    table.dropIndex('idx_services_business_active');
    table.dropIndex('idx_services_category_active');
    table.dropIndex('idx_services_professional_active');
  });

  await knex.schema.alterTable('professionals', (table) => {
    table.dropIndex('idx_professionals_business_active');
    table.dropIndex('idx_professionals_user');
    table.dropIndex('idx_professionals_specialty_active');
  });

  await knex.schema.alterTable('reviews', (table) => {
    table.dropIndex('idx_reviews_business_created');
    table.dropIndex('idx_reviews_professional_created');
    table.dropIndex('idx_reviews_client_created');
    table.dropIndex('idx_reviews_rating');
  });

  await knex.schema.alterTable('payments', (table) => {
    table.dropIndex('idx_payments_appointment');
    table.dropIndex('idx_payments_client_created');
    table.dropIndex('idx_payments_business_created');
    table.dropIndex('idx_payments_status_created');
    table.dropIndex('idx_payments_method_created');
  });

  await knex.schema.alterTable('users', (table) => {
    table.dropIndex('idx_users_email');
    table.dropIndex('idx_users_phone');
    table.dropIndex('idx_users_business_role');
    table.dropIndex('idx_users_active_created');
  });
};
